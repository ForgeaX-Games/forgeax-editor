import { describe, expect, test } from 'bun:test';
import {
  loadRuntimeBinding,
  type RuntimeBindingLoaderOptions,
} from '../runtime-binding-loader';

const binding = {
  schemaVersion: 'runtime-asset-binding-v1' as const,
  gameId: 'sample',
  scopeId: 'sample-scope',
  generation: 1,
  status: 'ready' as const,
  catalogUrl: '/__pack/scopes/sample-scope/1/catalog.json',
  importUrlBase: '/__pack/scopes/sample-scope/1/import',
  packageUrlBase: '/__pack/scopes/sample-scope/1/asset',
  catalogRoots: [{ root: 'assets', catalogPrefix: 'host-games/sample/assets' }],
};

function options(overrides: Partial<RuntimeBindingLoaderOptions> = {}): RuntimeBindingLoaderOptions {
  return {
    maxWaitMs: 100,
    retryDelayMs: 0,
    requestTimeoutMs: 100,
    sleep: async () => undefined,
    ...overrides,
  };
}

describe('runtime binding loader', () => {
  test('keeps the browser binding URL-only and free of host filesystem roots', () => {
    const serialized = JSON.stringify(binding);

    expect(serialized).not.toContain('gameDir');
    expect(serialized).not.toContain('projectDdcRoot');
    expect(serialized).not.toContain('buildCacheRoot');
    expect(Object.keys(binding)).not.toContain('ddcRoot');
  });

  test('retries a cold-start response until the authoritative binding is published', async () => {
    let calls = 0;
    const result = await loadRuntimeBinding(
      '/__pack/runtime-binding.json',
      async () => {
        calls += 1;
        if (calls < 2) return new Response(JSON.stringify({ status: 'transitioning' }), { status: 503 });
        return new Response(JSON.stringify(binding), { status: 200 });
      },
      options(),
    );
    expect(calls).toBe(2);
    expect(result).toEqual(binding);
  });

  test('preserves the explicit empty-game signal', async () => {
    const result = await loadRuntimeBinding(
      '/__pack/runtime-binding.json',
      async () => new Response(JSON.stringify({ status: 'unbound' }), { status: 503 }),
      options(),
    );
    expect(result).toBeUndefined();
  });

  test('reports the last transport state when the overall deadline expires', async () => {
    await expect(
      loadRuntimeBinding(
        '/__pack/runtime-binding.json',
        async () => new Response('not-json', { status: 502 }),
        options({ maxWaitMs: 1 }),
      ),
    ).rejects.toThrow('HTTP 502');
  });
});
