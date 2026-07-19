// fetch-timeout.test.ts — timeout-race behavior contract for fetchWithTimeout.
//
// Anchors:
//   requirements AC-08 (boot-safe timeout — a wedged fetch must settle within
//     `ms` with a detectable failure, never hang forever; WKWebView-wedge guard)
//   plan-strategy §5.1 M4 (fetchWithTimeout timeout behavior test-first)
//   plan-strategy D-5 (fetchSafe timeout race inlined INTO net.ts — the timeout
//     logic becomes self-contained in fetchWithTimeout, no ApiClient delegation)
//   net.ts:1-23 (WKWebView wedged-fetch rationale — retained through M4)
//
// This pins the OBSERVABLE contract of fetchWithTimeout so the M3 inlining
// (fetchSafe timeout race → net.ts fetchWithTimeout) preserves it:
//   - a resolving fetch flows through unchanged (returns the Response);
//   - a fetch that NEVER settles is abandoned and the call rejects within `ms`
//     (bounded), so a boot behind top-level await can fall back instead of
//     wedging the whole editor.

import { afterEach, describe, expect, it, mock } from 'bun:test';
import { fetchWithTimeout } from '../io/net';

function mockFetch(
  impl: (url: string, init?: RequestInit) => Promise<Partial<Response>>,
): void {
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    return impl(url, init) as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

describe('fetchWithTimeout — happy path', () => {
  afterEach(() => mock.restore());

  it('returns the Response when the underlying fetch resolves', async () => {
    const body = { ok: true, status: 200 } as Partial<Response>;
    mockFetch(async () => body);

    const r = await fetchWithTimeout('/api/health', 1000);
    expect(r.status).toBe(200);
    expect(r.ok).toBe(true);
  });

  it('forwards the request path to the underlying fetch (same-origin relative)', async () => {
    let seenUrl = '';
    mockFetch(async (url: string) => {
      seenUrl = url;
      return { ok: true, status: 200 };
    });

    await fetchWithTimeout('/api/files?path=x', 1000);
    // base is '' (same-origin) — the path is forwarded byte-identically.
    expect(seenUrl).toBe('/api/files?path=x');
  });
});

describe('fetchWithTimeout — timeout race (AC-08)', () => {
  afterEach(() => mock.restore());

  it('rejects within `ms` when the underlying fetch never settles', async () => {
    // A connection that wedges forever (WKWebView repro). The dangling promise
    // must be abandoned so the race settles and the caller can fall back.
    mockFetch(() => new Promise<Partial<Response>>(() => { /* never resolves */ }));

    const ms = 40;
    const started = Date.now();
    await expect(fetchWithTimeout('/api/files/tree', ms)).rejects.toThrow();
    const elapsed = Date.now() - started;

    // Detectable failure, bounded well under a would-be hang. Generous ceiling
    // to stay stable on a loaded CI box while still proving "does not hang".
    expect(elapsed).toBeLessThan(1000);
  });

  it('aborts the wedged request via the signal on timeout', async () => {
    // The race also fires an abort best-effort to free the socket — observable
    // as an aborted signal on the init passed to the underlying fetch.
    let seenSignal: AbortSignal | undefined;
    mockFetch((_url: string, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return new Promise<Partial<Response>>(() => { /* never resolves */ });
    });

    await expect(fetchWithTimeout('/api/files/tree', 30)).rejects.toThrow();
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal!.aborted).toBe(true);
  });
});
