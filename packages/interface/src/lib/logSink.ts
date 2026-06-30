/**
 * logSink — best-effort persistence of the in-memory observe/debug streams
 * (Console / Network / Info) to disk via `POST /api/logs`.
 *
 * Why: those three streams live only in the browser store (cap 500, in-memory),
 * so a refresh / crash / closed tab loses them — useless for after-the-fact
 * debugging. This sink mirrors every entry to `.forgeax/logs/<stream>.jsonl`
 * on the server (size-rotated there).
 *
 * Contract: `recordLog(stream, entry)` is fire-and-forget and NEVER throws into
 * its caller (the store mutators) — logging must not break the UI. Entries are
 * batched and flushed on a short debounce, when a queue gets large, or when the
 * tab is hidden / unloaded (sendBeacon) so the last buffer survives a close.
 */

export type LogStream = 'console' | 'network' | 'info';

// Per-page-load correlation id, stamped onto every POST so the three client
// streams (console/network/info) of ONE browser session can be joined on disk
// (and matched against a session's window in the server log). Minted once.
const SESSION_ID: string = (() => {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return c.randomUUID();
  } catch { /* no crypto */ }
  return `sid-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
})();

const QUEUES: Record<LogStream, Record<string, unknown>[]> = { console: [], network: [], info: [] };
const FLUSH_MS = 2000;
const MAX_QUEUE = 100; // flush immediately past this to bound memory + payload size
let timer: ReturnType<typeof setTimeout> | null = null;

// Disk-write dedup: a per-frame error flood (e.g. a RAF-loop console.error at
// 60Hz) would otherwise write 60 identical lines/sec. Collapse consecutive
// identical entries within a window onto a single queued record + `repeat` count.
// (The in-memory store's collapseEntries only folds the UI view, not disk.)
const DEDUP_WINDOW_MS = 1000;
const lastSig: Record<LogStream, { sig: string; ts: number; entry: Record<string, unknown> } | null> = {
  console: null, network: null, info: null,
};
function sigOf(entry: unknown): string {
  if (!entry || typeof entry !== 'object') return String(entry);
  const { ts: _ts, id: _id, repeat: _r, ...rest } = entry as Record<string, unknown>;
  void _ts; void _id; void _r;
  try { return JSON.stringify(rest); } catch { return ''; }
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => { timer = null; void flushAll(); }, FLUSH_MS);
}

async function flushStream(stream: LogStream): Promise<void> {
  const entries = QUEUES[stream];
  if (entries.length === 0) return;
  // Detach the current batch up front so concurrent recordLog calls queue into
  // a fresh array (and we don't double-send on failure).
  QUEUES[stream] = [];
  lastSig[stream] = null; // post-flush dups start a fresh record (don't bump a sent one)
  try {
    await fetch('/api/logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream, entries, sessionId: SESSION_ID }),
      keepalive: true,
    });
  } catch {
    // Drop on failure rather than retry — an unreachable server shouldn't grow
    // an unbounded in-memory backlog. The store still has the live entries.
  }
}

async function flushAll(): Promise<void> {
  await Promise.all((Object.keys(QUEUES) as LogStream[]).map(flushStream));
}

export function recordLog(stream: LogStream, entry: unknown): void {
  try {
    const now = Date.now();
    const sig = sigOf(entry);
    const last = lastSig[stream];
    if (last && last.sig === sig && now - last.ts < DEDUP_WINDOW_MS) {
      // Identical flood within the window → bump `repeat` on the queued record
      // instead of pushing a duplicate line.
      last.entry.repeat = (typeof last.entry.repeat === 'number' ? last.entry.repeat : 1) + 1;
      last.ts = now;
      return;
    }
    const rec: Record<string, unknown> = (entry && typeof entry === 'object')
      ? (entry as Record<string, unknown>)
      : { value: entry };
    const q = QUEUES[stream];
    q.push(rec);
    lastSig[stream] = { sig, ts: now, entry: rec };
    if (q.length >= MAX_QUEUE) void flushStream(stream);
    else schedule();
  } catch { /* never throw into the UI */ }
}

// Flush via sendBeacon on tab hide / unload — fetch() may be cancelled mid-flight
// when the document is tearing down, but a beacon is guaranteed-delivered.
if (typeof window !== 'undefined') {
  const beaconFlush = (): void => {
    for (const stream of Object.keys(QUEUES) as LogStream[]) {
      const entries = QUEUES[stream];
      if (entries.length === 0) continue;
      QUEUES[stream] = [];
      try {
        const blob = new Blob([JSON.stringify({ stream, entries, sessionId: SESSION_ID })], { type: 'application/json' });
        navigator.sendBeacon('/api/logs', blob);
      } catch { /* ignore */ }
    }
  };
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') beaconFlush();
  });
  window.addEventListener('pagehide', beaconFlush);
}
