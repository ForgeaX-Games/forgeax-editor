// api-client.ts — the editor's same-origin `/api` transport helper.
//
// WHY this is now a thin helper (M4 / AC-06 / plan-strategy D-5):
//   The former DIP seam here was a dead abstraction that never actually
//   switched: an injected client with get/set/create-default accessors, where
//   studio and standalone both used the same relative-`/api` default. AI users
//   paid a comprehension tax reasoning about "when does the injected client take
//   effect?" (answer: never). M4 collapses the seam to a single same-origin
//   function so backend calls read as what they are: a `fetch` against the same
//   origin's `/api`. The three accessor symbols + the interface are deleted.
//
// CONTRACT — byte-for-byte equivalent to the prior default client (base=''):
//   apiFetch(path, init) -> fetch(path, init), a same-origin relative request.
//   The request path/method/headers/body are all decided by callers. The B2
//   vite proxy topology is unchanged (R-B2): a relative `/api/...` request.
//
// FILENAME is load-bearing — do NOT rename or move this file. The api-seam gate
// (scripts/lint-no-direct-api-fetch.mjs) exempts direct `/api` fetches BY
// FILENAME `api-client.ts` (:62); the helper lives here so it can hold the one
// real same-origin fetch. Callers use `apiFetch` (capital F) which does not
// match the gate's lowercase `fetch(` token, so consumer call sites stay clean.
//
// The boot-safe timeout race that used to live in the removed client method
// moved into net.ts's `fetchWithTimeout` (self-contained; see net.ts:1-23 for
// the WKWebView-wedge rationale). Use `fetchWithTimeout` for boot-path calls
// that must settle within a deadline; use `apiFetch` for ordinary backend calls.

/** Same-origin `/api` fetch. `path` is a relative path (e.g. `/api/files?...`);
 *  the request is issued against the same origin, byte-identical to the prior
 *  default client (base=''). */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, init);
}
