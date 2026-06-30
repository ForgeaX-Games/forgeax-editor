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
// R2: the timeout-race body moved into the injected ApiClient (api-client.ts);
// this is now a thin delegate so the 16 existing call sites keep their `url`
// argument unchanged. `url` is the path (e.g. `/api/files?...`); the client
// prepends its base ('' in studio mode ⇒ byte-identical relative fetch).
import { getApiClient } from './api-client';

export async function fetchWithTimeout(url: string, ms = 6000): Promise<Response> {
  return getApiClient().fetchSafe(url, undefined, ms);
}
