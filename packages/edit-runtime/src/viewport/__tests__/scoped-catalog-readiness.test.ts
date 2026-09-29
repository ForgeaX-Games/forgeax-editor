import { afterEach, describe, expect, it } from 'bun:test';
import { waitForScopedPackCatalog } from '../scoped-catalog-readiness';

const binding = {
  catalogUrl: 'http://127.0.0.1/catalog.json',
  scopeId: 'studio-test',
  generation: 42,
};

describe('waitForScopedPackCatalog', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns ok when catalog responds with matching scope snapshot', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      schemaVersion: 'runtime-catalog-snapshot-v1',
      scopeId: 'studio-test',
      generation: 42,
      authority: 'authoritative',
      entries: [],
    }), { status: 200 })) as unknown as typeof fetch;

    const result = await waitForScopedPackCatalog(binding, () => true, {
      timeoutMs: 500,
      pollMs: 10,
    });
    expect(result.ok).toBe(true);
  });

  it('retries transient 503 then succeeds', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: 'runtime-scope-unavailable', status: 'transitioning' }), {
          status: 503,
        });
      }
      return new Response(JSON.stringify({
        schemaVersion: 'runtime-catalog-snapshot-v1',
        scopeId: 'studio-test',
        generation: 42,
        entries: [],
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await waitForScopedPackCatalog(binding, () => true, {
      timeoutMs: 500,
      pollMs: 10,
    });
    expect(result.ok).toBe(true);
    expect(calls).toBeGreaterThan(1);
  });

  it('fails when degraded snapshot has no entries', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      schemaVersion: 'runtime-catalog-snapshot-v1',
      scopeId: 'studio-test',
      generation: 42,
      authority: 'degraded',
      entries: [],
      diagnostics: [{ code: 'catalog-scan-failed' }],
    }), { status: 200 })) as unknown as typeof fetch;

    const result = await waitForScopedPackCatalog(binding, () => true, {
      timeoutMs: 500,
      pollMs: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('degraded with no discoverable entries');
    }
  });

  it('fails fast when scope is not registered', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'runtime-scope-not-found' }), {
      status: 404,
    })) as unknown as typeof fetch;

    const result = await waitForScopedPackCatalog(binding, () => true, {
      timeoutMs: 500,
      pollMs: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('not registered');
    }
  });

  it('follows runtime-scope-generation-expired 410 to the current generation', async () => {
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls += 1;
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/1789894677777/')) {
        return new Response(JSON.stringify({
          error: 'runtime-scope-generation-expired',
          scopeId: 'studio-test',
          generation: 1789894677777,
          currentGeneration: 1789894677778,
        }), { status: 410 });
      }
      return new Response(JSON.stringify({
        schemaVersion: 'runtime-catalog-snapshot-v1',
        scopeId: 'studio-test',
        generation: 1789894677778,
        entries: [{ id: 'scene' }],
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await waitForScopedPackCatalog({
      catalogUrl: 'http://127.0.0.1/preview/__pack/scopes/studio-test/1789894677777/catalog.json',
      scopeId: 'studio-test',
      generation: 1789894677777,
    }, () => true, {
      timeoutMs: 500,
      pollMs: 10,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.effectiveGeneration).toBe(1789894677778);
    }
    expect(calls).toBe(2);
  });

  it('retries runtime-scope-unbound 404 until catalog is ready', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: 'runtime-scope-unbound' }), { status: 404 });
      }
      return new Response(JSON.stringify({
        schemaVersion: 'runtime-catalog-snapshot-v1',
        scopeId: 'studio-test',
        generation: 42,
        entries: [],
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await waitForScopedPackCatalog(binding, () => true, {
      timeoutMs: 500,
      pollMs: 10,
    });
    expect(result.ok).toBe(true);
    expect(calls).toBeGreaterThan(1);
  });
});
