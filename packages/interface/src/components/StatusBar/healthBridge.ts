/**
 * Health bridge — wires every error/health source into the health store.
 *
 * Install ONCE at boot (see main.tsx). Idempotent.
 *
 * Sources captured here:
 *   1. The shell itself: window 'error' / 'unhandledrejection' + a console.error
 *      wrapper → source 'shell'.
 *   2. iframe-forwarded health: `postMessage({type:'forgeax:health', level,
 *      source, code, message})` from play / edit / plugin runtimes (cross-origin,
 *      so this is how their console errors reach the shell at all).
 *   3. The pre-existing VAG wire: VAG_CONSOLE (error/warn lines) + VAG_DEVICE_LOST.
 *      These already reach the host window from the runtimes; we map them onto the
 *      health store too so nothing is missed even before a runtime ships the new
 *      `forgeax:health` envelope. Source is inferred from the iframe URL.
 *
 * We deliberately do NOT import @forgeax/editor here (that would re-create the
 * interface→editor cycle the panel-renderer split removed). The wire contract is
 * plain postMessage shapes validated inline.
 */

import { pushHealth, type HealthLevel, type HealthSource } from './healthStore';
import { isTrustedMessageOrigin } from '../../lib/trustedOrigins';
import { useAppStore, type NetworkEntry } from '../../store';

let installed = false;

const CONSOLE_LEVELS = ['log', 'warn', 'error', 'info', 'debug'] as const;
type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];
function asConsoleLevel(x: unknown): ConsoleLevel {
  return (CONSOLE_LEVELS as readonly string[]).includes(String(x)) ? (String(x) as ConsoleLevel) : 'log';
}

function asLevel(x: unknown): HealthLevel {
  switch (x) {
    case 'success': return 'success';
    case 'warn':
    case 'warning': return 'warn';
    case 'error': return 'error';
    default: return 'info';
  }
}

function asSource(x: unknown): HealthSource {
  switch (x) {
    case 'play': return 'play';
    case 'edit': return 'edit';
    case 'plugin': return 'plugin';
    case 'engine': return 'engine';
    default: return 'shell';
  }
}

/** Map a console level → health level (log/info/debug collapse to info). */
function consoleLevelToHealth(level: string): HealthLevel | null {
  if (level === 'error') return 'error';
  if (level === 'warn') return 'warn';
  return null; // skip log/info/debug noise — only surface warn+ from iframes.
}

/** Best-effort: figure out which region an iframe message came from by its URL. */
function sourceFromEvent(ev: MessageEvent): HealthSource {
  try {
    const win = ev.source as Window | null;
    if (win) {
      const frames = document.querySelectorAll('iframe');
      for (const f of Array.from(frames)) {
        if (f.contentWindow === win) {
          const src = f.getAttribute('src') ?? '';
          if (src.includes('/preview')) return 'play';
          if (src.includes('/editor')) return 'edit';
          return 'plugin';
        }
      }
    }
  } catch { /* cross-origin / detached */ }
  // Fall back to URL hints in the message origin.
  return 'engine';
}

export function installHealthBridge(): void {
  if (installed) return;
  installed = true;

  // ── 1. Shell-self errors ───────────────────────────────────────────────────
  window.addEventListener('error', (ev) => {
    // Resource-load errors (img/script) surface as Event w/o .message; skip the
    // favicon-class noise but keep script errors.
    const msg = ev.message || (ev.error instanceof Error ? ev.error.message : '');
    if (!msg) return;
    pushHealth({
      level: 'error',
      source: 'shell',
      code: 'window-error',
      message: ev.filename ? `${msg}  (${ev.filename}:${ev.lineno})` : msg,
    });
  });

  window.addEventListener('unhandledrejection', (ev) => {
    const reason = (ev as PromiseRejectionEvent).reason;
    const msg = reason instanceof Error ? (reason.stack?.split('\n')[0] ?? reason.message) : String(reason);
    pushHealth({ level: 'error', source: 'shell', code: 'unhandled-rejection', message: `unhandled rejection: ${msg}` });
  });

  // Wrap console.error so shell-side fetch rejects / React warnings that only
  // hit console.error still land in the INFO feed. Keep the original behaviour.
  const fmtArgs = (args: unknown[]): string =>
    args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');

  const origError = console.error.bind(console);
  console.error = (...args: unknown[]): void => {
    origError(...args);
    try {
      const text = fmtArgs(args);
      // Skip messages this bridge itself produced via pushHealth → console (avoid loops).
      if (text.startsWith('[health]')) return;
      pushHealth({ level: 'error', source: 'shell', code: 'console-error', message: text });
    } catch { /* never let logging throw */ }
  };

  // Also wrap console.warn — shell-side warnings (incl. the [vag]/[sync] rejection
  // diagnostics and the trustedOrigins guards) were previously NOT captured into
  // the health feed (only console.error was), so they died in DevTools.
  const origWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]): void => {
    origWarn(...args);
    try {
      const text = fmtArgs(args);
      if (text.startsWith('[health]')) return;
      pushHealth({ level: 'warn', source: 'shell', code: 'console-warn', message: text });
    } catch { /* never let logging throw */ }
  };

  // ── 2 + 3. iframe-forwarded messages ───────────────────────────────────────
  window.addEventListener('message', (ev: MessageEvent) => {
    if (!isTrustedMessageOrigin(ev.origin)) return; // foreign-origin guard
    const data = ev.data as { type?: unknown; payload?: unknown } | null;
    const type = data?.type;
    if (typeof type !== 'string') return;

    // New explicit health envelope (preferred path from the runtimes).
    if (type === 'forgeax:health') {
      const d = data as { level?: unknown; source?: unknown; code?: unknown; message?: unknown };
      const message = typeof d.message === 'string' ? d.message : '';
      if (!message) return;
      pushHealth({
        level: asLevel(d.level),
        // Trust the runtime's self-declared source; fall back to URL inference.
        source: d.source ? asSource(d.source) : sourceFromEvent(ev),
        code: typeof d.code === 'string' ? d.code : undefined,
        message,
      });
      return;
    }

    // Legacy VAG wire fallback — only used for sources that DON'T yet ship the
    // `forgeax:health` envelope (e.g. plugin iframes). Play/Edit surfaces forward
    // their own forgeax:health (PlaySurface/EditSurface), so mapping VAG_CONSOLE
    // for them would double-log; skip those, keep plugin/unknown frames.
    if (type === 'VAG_CONSOLE') {
      const payload = data?.payload as { level?: unknown; text?: unknown; ts?: unknown } | undefined;
      const text = typeof payload?.text === 'string' ? payload.text : '';
      if (!text) return;
      // Console panel: the FULL stream (all levels, all sources). Play/Edit
      // surfaces re-forward their nested engine iframe's VAG_CONSOLE up to here,
      // so this is the single point that feeds store.consoleLog.
      useAppStore.getState().pushConsole({
        level: asConsoleLevel(payload?.level),
        text,
        ts: typeof payload?.ts === 'number' ? payload.ts : Date.now(),
      });
      // Health feed: only error/warn, and only from plugin/unknown frames —
      // play/edit forward their own forgeax:health for errors (avoid double-log).
      const src = sourceFromEvent(ev);
      if (src !== 'play' && src !== 'edit') {
        const lvl = consoleLevelToHealth(String(payload?.level));
        if (lvl) pushHealth({ level: lvl, source: src, code: 'vag-console', message: text });
      }
      return;
    }

    // Network panel feed — Play/Edit surfaces re-forward their engine iframe's
    // VAG_NETWORK up to here (the single point that feeds store.networkLog).
    if (type === 'VAG_NETWORK') {
      const p = data?.payload as Partial<NetworkEntry> | undefined;
      if (!p || typeof p.url !== 'string') return;
      useAppStore.getState().pushNetwork({
        kind: (['fetch', 'xhr', 'ws'] as const).includes(p.kind as never) ? (p.kind as NetworkEntry['kind']) : 'fetch',
        method: typeof p.method === 'string' ? p.method : 'GET',
        url: p.url,
        status: typeof p.status === 'number' ? p.status : 0,
        ms: typeof p.ms === 'number' ? p.ms : 0,
        ok: Boolean(p.ok),
        ts: typeof p.ts === 'number' ? p.ts : Date.now(),
      });
      return;
    }
  });
}
