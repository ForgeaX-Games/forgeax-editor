// Workspace hot-switch reload helpers (todo 005).
//
// Activating a workspace (POST /api/workspaces/activate) repoints the engine's
// `.forgeax` symlink, which makes the engine vite's `forgeaxGameRescan` plugin
// fire `server.restart()`. During that restart window `/preview/` is down. If a
// tab reloads the host page WHILE the engine is mid-restart, the freshly-mounted
// PlaySurface loads the preview against a dead engine, goes blank, and its own
// restart-probe reloads the iframe again → the "preview reloads multiple times /
// 白屏转圈" symptom. Two independent host-reload paths (the explicit reload in
// ProjectSwitcher and the `workspace-changed` broadcast handler) made this worse.
//
// These helpers converge both paths onto: (1) wait for the engine to come back
// up, then (2) reload the host AT MOST ONCE. Both are pure browser primitives —
// no interface store / app imports — so broadcast.ts and ProjectSwitcher can
// share them without cycles.

/**
 * Resolve once the engine preview endpoint has settled after a workspace switch.
 *
 * The engine's rescan restart is debounced (~400ms after the symlink flip), so
 * we take a short head start before sampling — otherwise we'd observe the
 * pre-restart "up" and return too early. Then we wait for two consecutive
 * healthy probes. Bounded by a deadline so a switch that triggers no restart
 * (identical game-slug set → no rescan) or a wedged engine can never hang the
 * caller; the PlaySurface restart-probe remains as the graceful-degradation
 * fallback if the deadline is hit.
 *
 * @param slug active game slug to probe; undefined → nothing to preview, no wait.
 */
export async function waitForEngineSettled(slug?: string): Promise<void> {
  if (typeof window === 'undefined' || !slug) return;
  const url = `/preview/?game=${encodeURIComponent(slug)}`;
  const deadline = Date.now() + 8000;
  const wait = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
  const ping = async (): Promise<boolean> => {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      try { await r.body?.cancel(); } catch { /* ignore */ }
      return r.ok;
    } catch { return false; }
  };
  await wait(600);
  let upStreak = 0;
  while (Date.now() < deadline) {
    upStreak = (await ping()) ? upStreak + 1 : 0;
    if (upStreak >= 2) return; // stably back up
    await wait(250);
  }
}

/**
 * Reload the host window for a workspace switch, at most once per page lifetime.
 *
 * Both reload paths (explicit ProjectSwitcher reload + `workspace-changed`
 * broadcast handler) route through here. The per-window latch guarantees that
 * even if both fire — in different ticks, after independent `waitForEngineSettled`
 * awaits — the page reloads exactly once. The flag lives on the current window
 * only, so it resets naturally after navigation; it does not affect unrelated
 * reloads (ErrorBoundary / Settings call `location.reload()` directly).
 */
export function reloadOnceForWorkspace(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { __forgeaxWorkspaceReloading?: boolean };
  if (w.__forgeaxWorkspaceReloading) return;
  w.__forgeaxWorkspaceReloading = true;
  window.location.reload();
}
