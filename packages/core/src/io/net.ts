// Boot-safe networking primitive shared across editor-core.
//
// fetch() that is GUARANTEED to settle within `ms`, even if the underlying
// connection wedges forever. The editor boots behind top-level `await`s
// (initSceneList → loadDocFromDisk → createApp, edit-runtime main.tsx), so a
// single stalled boot fetch wedges the ENTIRE editor (black viewport, FPS "--",
// no mount, no recovery, status bar frozen on "boot ▸ initSceneList"). On the
// real desktop (WKWebView) this reproduces intermittently: `/api/files/tree` is
// instant via curl, yet the iframe's fetch never resolves — and an
// AbortController does NOT reliably reject a wedged WKWebView connection (the
// old impl hung >45s despite a 6s abort). So we RACE the fetch against a timer
// that REJECTS: the dangling fetch promise is simply abandoned, the race
// settles, and the caller's try/catch falls back to empty/legacy — boot always
// proceeds. The abort is still fired best-effort to free the socket.
//
// Lives in its own module (not store.ts) so BOTH store.ts and assets.ts can use
// it without a circular import — store.ts already imports findScenePackByGuid
// from assets.ts, and the boot path runs through assets.ts too.
//
// M4 (AC-08 / plan-strategy D-5): the timeout-race body is now SELF-CONTAINED
// here. It previously lived in the injected client's `fetchSafe`
// method, which this module delegated to. The DIP seam is gone
// (the client never actually switched), so the race — AbortController +
// Promise.race([fetch, timer-reject]) + finally clearTimeout — moves back in
// beside the WKWebView rationale above. `url` is the path (e.g. `/api/files?...`)
// fetched same-origin (relative), byte-identical to the prior default client
// (base=''); the request path/method/headers/body are still decided by callers.
export async function fetchWithTimeout(url: string, ms = 6000): Promise<Response> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { ctrl.abort(); } catch { /* ignore */ }
      reject(new Error('fetch-timeout'));
    }, ms);
  });
  try {
    return await Promise.race([fetch(url, { signal: ctrl.signal }), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
