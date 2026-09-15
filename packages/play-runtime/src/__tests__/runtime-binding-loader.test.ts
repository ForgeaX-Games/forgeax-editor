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

for (const status of [200, 503]) {
  test(`known blocking failure for this binding fails immediately for HTTP ${status}`, async () => {
    const diagnostic = { code: 'scan-failed', severity: 'blocking', cause: [{ code: 'pack-source-external-closure-mismatch', detail: { sourcePath: './assets/scene.pack.ts', unusedDeclaredGuids: ['guid'] } }] };
    let calls = 0;
    const failure = await loadRuntimeBinding('binding', async () => {
      calls++;
      return Response.json({ ...binding, status: status === 200 ? 'degraded' : 'unavailable', diagnostic, diagnostics: [diagnostic] }, { status });
    }, options({ expected: binding })).catch(error => error);
    expect(calls).toBe(1);
    expect(failure.code).toBe('pack-source-external-closure-mismatch');
    expect(failure.retryable).toBe(false);
    expect(failure.diagnostics.at(-1)).toEqual({ code: 'pack-source-external-closure-mismatch', sourcePath: './assets/scene.pack.ts', unusedDeclaredGuids: ['guid'] });
  });
}

test('old-generation unavailable diagnostics cannot describe this Play attempt', async () => {
  let calls = 0;
  const result = await loadRuntimeBinding('binding', async () => {
    calls++;
    return calls === 1 ? Response.json({ ...binding, generation: 2, status: 'unavailable', diagnostic: { code: 'old-error' } }, { status: 503 }) : Response.json(binding);
  }, options({ expected: binding }));
  expect(calls).toBe(2);
  expect(result).toEqual(binding);
});
test('a different game ready response cannot be accepted', async () => {
  await expect(loadRuntimeBinding('binding', async () => Response.json({ ...binding, gameId: 'other' }), options({ expected: binding }))).rejects.toMatchObject({ code: 'play-runtime-scope-stale' });
});
test('temporary transport failure is retried without inventing a pack error', async () => {
  let calls = 0;
  expect(await loadRuntimeBinding('binding', async () => {
    if (++calls === 1) throw new Error('temporary network loss');
    return Response.json(binding);
  }, options({ expected: binding }))).toEqual(binding);
  expect(calls).toBe(2);
});
