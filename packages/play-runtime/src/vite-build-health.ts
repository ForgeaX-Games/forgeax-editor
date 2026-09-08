import { sendVagMessage, VagConsoleSchema } from '@forgeax/editor-core/protocol';

/**
 * Collapse the SAME transform reported twice into one build failure.
 *
 * Vite announces one failed transform through two channels — the `vite:error`
 * HMR event and the injected `<vite-error-overlay>` — so a naive forward
 * double-reports it. Dedupe is therefore keyed on the message, NOT on time
 * alone: two *different* errors inside the window are two real failures, and
 * main's original handler forwarded every one of them. Time-only keying would
 * silently drop the second, which is a regression against that behaviour.
 *
 * The overlay text embeds the event text (plugin prefix, frame), so compare on
 * a containment basis rather than equality.
 */
export function createBuildFailureDeduper(withinMs = 1_000) {
  let lastFailureAt = Number.NEGATIVE_INFINITY;
  let lastText = '';
  return (message: string, now: number): string | null => {
    const text = message.trim() || 'build error';
    const sameTransform = lastText !== ''
      && (text.includes(lastText) || lastText.includes(text));
    if (sameTransform && now - lastFailureAt < withinMs) return null;
    lastFailureAt = now;
    lastText = text;
    return text;
  };
}

const dedupeBuildFailure = createBuildFailureDeduper();

function reportBuildFailure(message: string): void {
  const now = Date.now();
  const text = dedupeBuildFailure(message, now);
  if (text === null) return;
  sendVagMessage(window.parent, VagConsoleSchema, {
    level: 'error',
    text: `[vite build] ${text}`,
    ts: now,
  });
  window.parent?.postMessage({
    type: 'forgeax:health',
    level: 'error',
    source: 'play',
    code: 'vag-console',
    message: `[vite build] ${text}`,
  }, '*');
}

// This module is imported before Play boot starts. A game transform can fail
// during the first dynamic import, so installing the listener later in main.ts
// misses exactly the build failure it is meant to report.
if (import.meta.hot) {
  import.meta.hot.on('vite:error', (...args: unknown[]) => {
    try {
      const payload = args[0] as { err?: { message?: string; id?: string; loc?: { file?: string; line?: number } } } | undefined;
      const err = payload?.err;
      const where = err?.loc?.file
        ? ` (${err.loc.file}${err.loc.line ? `:${err.loc.line}` : ''})`
        : err?.id ? ` (${err.id})` : '';
      reportBuildFailure(`${err?.message ?? 'build error'}${where}`);
    } catch {
      // Build telemetry is best effort and must not replace Vite's own overlay.
    }
  });
}

// Initial dynamic-import failures arrive as an injected Vite overlay rather
// than an HMR custom event. Observe that real overlay so cold-boot and HMR
// failures share the same health signal.
//
// Cost discipline: Vite injects <vite-error-overlay> as a DIRECT child of
// <body>, so watch only body's childList — NOT documentElement+subtree. A
// subtree observer fires on every DOM mutation in the page, and Play mutates
// the DOM continuously (canvas, HUD, diagnostics), so each mutation would run
// a whole-document querySelectorAll. That turns a rare build-failure probe into
// a per-frame full-tree scan and grows the dev server's memory until the OOM
// killer takes it (observed as `[WebServer] Killed` on heavy CI runners).
// Inspect only the added nodes; the initial sweep below covers an overlay that
// already exists before this module runs.
if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
  const seen = new WeakSet<Element>();
  const report = (overlay: Element): void => {
    if (seen.has(overlay)) return;
    seen.add(overlay);
    const text = overlay.shadowRoot?.textContent ?? overlay.textContent ?? 'build error';
    try { reportBuildFailure(text); } catch { /* keep Vite's overlay authoritative */ }
  };
  const isOverlay = (node: Node): node is Element =>
    node.nodeType === 1 && (node as Element).tagName.toLowerCase() === 'vite-error-overlay';
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) if (isOverlay(node)) report(node);
    }
  });
  const attach = (): void => {
    observer.observe(document.body, { childList: true });
    for (const overlay of document.body.querySelectorAll('vite-error-overlay')) report(overlay);
  };
  if (document.body) attach();
  else document.addEventListener('DOMContentLoaded', attach, { once: true });
  window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
}
