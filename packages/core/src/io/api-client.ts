// api-client.ts — the editor's DIP seam to its backend (R2).
//
// WHY this exists (roadmap §4/§5, "editor 快车道" R2):
//   editor (前L2) must NOT hardcode `fetch('/api/...')`. Every backend call —
//   file read/write, asset import, gltf processing — goes through an INJECTED
//   ApiClient. studio mode injects the default (relative `/api`, same bytes as
//   before); a standalone editor (R3) injects a client that points at its own
//   reused platform-io (后L1). One transport seam, two mount paths, zero
//   duplicated endpoint knowledge. The `fetch-reader.ts` irony ("baked the
//   convention back in") is the smell this seam removes — there is now a single
//   place that knows where `/api` lives.
//
// CONTRACT — the default client is byte-for-byte equivalent to the prior code:
//   - `fetch(path, init)`  → `globalThis.fetch(base + path, init)` (base='' ⇒
//     relative, exactly the old call).
//   - `fetchSafe(path, init, ms)` → the boot-safe timeout race that used to live
//     in net.ts (see net.ts header for the WKWebView-wedge rationale). net.ts's
//     `fetchWithTimeout` now delegates here, so its 16 call sites are unchanged.
//
// Swapping the client changes the transport (base URL / direct platform-io),
// never the wire shape — the request path, method, headers and body are all
// decided by callers, not by the client.

export interface ApiClient {
  /** Base prepended to every path (''=relative). */
  readonly base: string;
  /** Plain fetch against `base + path`. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /**
   * Boot-safe fetch GUARANTEED to settle within `ms`, even if the underlying
   * connection wedges forever (WKWebView desktop reproduces this). The dangling
   * fetch promise is abandoned; the race rejects so the caller's try/catch can
   * fall back and boot proceeds. See net.ts for the full rationale.
   */
  fetchSafe(path: string, init?: RequestInit, ms?: number): Promise<Response>;
}

/** Build a default ApiClient: relative `/api` (base='') or an explicit origin. */
export function createDefaultApiClient(base = ''): ApiClient {
  return {
    base,
    fetch(path, init) {
      return fetch(base + path, init);
    },
    fetchSafe(path, init, ms = 6000) {
      const ctrl = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try { ctrl.abort(); } catch { /* ignore */ }
          reject(new Error('fetch-timeout'));
        }, ms);
      });
      const merged: RequestInit = init ? { ...init, signal: ctrl.signal } : { signal: ctrl.signal };
      return (async () => {
        try {
          return await Promise.race([fetch(base + path, merged), timeout]);
        } finally {
          clearTimeout(timer!);
        }
      })();
    },
  };
}

// ── Module singleton — the injected client the whole editor reads ──────────────
//
// Default = relative-`/api` client, identical to the pre-R2 hardcoded fetches.
// A host (standalone R3, or a test) calls setApiClient() at boot to swap it.
let _client: ApiClient = createDefaultApiClient();

/** The active ApiClient. All editor backend calls route through this. */
export function getApiClient(): ApiClient {
  return _client;
}

/** Inject a different ApiClient (standalone mount, tests). Call at boot. */
export function setApiClient(client: ApiClient): void {
  _client = client;
}
