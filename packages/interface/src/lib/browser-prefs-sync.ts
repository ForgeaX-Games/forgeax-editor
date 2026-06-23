/** Persist + restore browser localStorage UI prefs via `/api/prefs/browser-localStorage`.
 *  Snapshot lands in `.forgeax/prefs/browser-localStorage.json` for export-instance. */

const SYNC_DEBOUNCE_MS = 1500;
const SYNC_INTERVAL_MS = 30_000;

const KEY_PREFIXES = ['forgeax.', 'wb-', 'wb:'];
const KEY_EXACT = ['wb-agent-persona:selected-agent-id'];

function shouldSyncKey(key: string): boolean {
  if (KEY_EXACT.includes(key)) return true;
  return KEY_PREFIXES.some((p) => key.startsWith(p));
}

export function captureBrowserLocalStorage(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const entries: Record<string, string> = {};
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !shouldSyncKey(key)) continue;
      const val = window.localStorage.getItem(key);
      if (val !== null) entries[key] = val;
    }
  } catch {
    /* private mode */
  }
  return entries;
}

export function restoreBrowserLocalStorage(entries: Record<string, string>): number {
  if (typeof window === 'undefined') return 0;
  let n = 0;
  try {
    for (const [key, val] of Object.entries(entries)) {
      if (!shouldSyncKey(key) || typeof val !== 'string') continue;
      window.localStorage.setItem(key, val);
      n += 1;
    }
  } catch {
    /* ignore */
  }
  return n;
}

async function pushBrowserPrefs(): Promise<void> {
  const entries = captureBrowserLocalStorage();
  if (Object.keys(entries).length === 0) return;
  try {
    await fetch('/api/prefs/browser-localStorage', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        v: 1,
        exportedAt: new Date().toISOString(),
        origin: window.location.origin,
        entries,
      }),
    });
  } catch {
    /* server may be down during boot */
  }
}

/** Push the current localStorage snapshot to the server immediately (no debounce).
 *  Call after a same-tab pref change that must survive a quick reload — the
 *  `storage` event only fires in OTHER tabs, so same-tab writes are otherwise
 *  only flushed on the 30s interval / beforeunload (unreliable). */
export function flushBrowserPrefs(): void {
  void pushBrowserPrefs();
}

/** Pull server snapshot into localStorage (server wins on first boot after import). */
export async function syncBrowserPrefsFromServer(): Promise<number> {
  try {
    const res = await fetch('/api/prefs/browser-localStorage');
    if (!res.ok) return 0;
    // Standalone (no backend) serves the SPA index.html for unknown /api
    // routes — a 200 with text/html. Guard against parsing that as JSON.
    if (!res.headers.get('content-type')?.includes('application/json')) return 0;
    const snap = (await res.json()) as { entries?: Record<string, string> };
    if (!snap.entries || Object.keys(snap.entries).length === 0) return 0;
    return restoreBrowserLocalStorage(snap.entries);
  } catch {
    return 0;
  }
}

let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let started = false;

function schedulePush(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = undefined;
    void pushBrowserPrefs();
  }, SYNC_DEBOUNCE_MS);
}

/** Start periodic + event-driven sync to server (call once from main.tsx). */
export function startBrowserPrefsSync(): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  window.addEventListener('storage', (e) => {
    if (e.key && shouldSyncKey(e.key)) schedulePush();
  });
  window.addEventListener('beforeunload', () => {
    void pushBrowserPrefs();
  });

  const interval = window.setInterval(() => {
    void pushBrowserPrefs();
  }, SYNC_INTERVAL_MS);

  window.addEventListener('beforeunload', () => {
    window.clearInterval(interval);
  });

  // Initial push after UI settles (captures keys written during boot).
  window.setTimeout(() => {
    void pushBrowserPrefs();
  }, 4000);
}
