import { expect, spyOn, test } from 'bun:test';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { ok } from '@forgeax/engine-types';
import { createAuthoredAssetCatalogBarrier } from '../assets/authored-asset-barrier';

test('post-write barrier refreshes a healthy scoped replica when no hot event arrives', async () => {
  const guid = '11111111-1111-4111-8111-111111111111';
  const row = { guid, kind: 'scene' as const, sourcePath: 'assets/scene.pack.ts', packageUrl: '/new-scene.pack.json' };
  const registry = new AssetRegistry({} as never);
  let published = false;
  let revision = 'first';
  let reads = 0;
  registry.setCatalogSource({
    enumerate: async () => { reads++; return ok(published ? [{ ...row, revision: { digest: revision, observedAt: reads, rootId: 'test-root' } }] : []); },
    subscribe: () => () => undefined,
  });
  await registry.enumerateCatalog();
  expect(registry.catalogSnapshot()?.stale).toBe(false);
  published = true;
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => new Response(JSON.stringify({ assets: [{ guid }] })), { preconnect: fetch.preconnect }));
  const loadSpy = spyOn(registry, 'loadByGuid').mockResolvedValue(ok({}) as never);
  try {
    await createAuthoredAssetCatalogBarrier(registry, { deadlineMs: 500, rowPollMs: 1, bodyPollMs: 1 })(guid);
    expect(reads).toBeGreaterThan(1);
    expect(registry.catalogSnapshot()?.entries.map((entry) => entry.guid)).toEqual([guid]);
    expect(loadSpy).toHaveBeenCalledTimes(1);
    // The first barrier pinned an abbreviated row. A subsequent edit must use
    // the new replica publication, not that pre-write payload cache.
    expect(registry.packIndexCache?.has(guid)).toBe(true);
    revision = 'second';
    await createAuthoredAssetCatalogBarrier(registry, { deadlineMs: 500, rowPollMs: 1, bodyPollMs: 1 })(guid, { previousRevision: 'first' });
    expect(registry.catalogSnapshot()?.entries[0]?.revision?.digest).toBe('second');
    expect(loadSpy).toHaveBeenCalledTimes(2);
  } finally {
    fetchSpy.mockRestore();
    loadSpy.mockRestore();
    registry.clearCatalogSource();
  }
});
