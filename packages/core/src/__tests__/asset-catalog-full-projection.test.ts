import { describe, expect, it } from 'bun:test';
import type { CatalogDelta, CatalogEntry } from '@forgeax/engine-types';
import { createAssetBrowserReadModel, type AssetBrowserRegistry } from '../assets/asset-browser-read-model';

function catalogEntry(guid: string, observedAt: number): CatalogEntry {
  return {
    guid,
    packageUrl: `catalog/assets/${guid}.pack.json`,
    kind: 'mesh',
    sourcePath: `catalog/assets/${guid}.glb`,
    packageId: `package-${guid}`,
    provenance: { provider: 'fixture', version: '1.0.0' },
    revision: { observedAt, digest: `digest-${observedAt}`, rootId: 'fixture-root' },
    sourceKey: 'mesh:0',
    sourceIndex: 0,
    sourceOverrides: { lod: { enabled: true } },
    sourceOverrideDescriptors: [{ sourceKey: 'mesh:0', payloadSchema: { type: 'object' } }],
    relations: [{ kind: 'depends-on', from: guid, to: 'dependency-guid' }],
    diagnostics: [{ code: 'fixture-diagnostic', severity: 'info', hint: 'fixture' }],
    name: `Asset ${guid}`,
    cookReceiptUrl: `/receipts/${guid}`,
    refs: ['dependency-guid'],
    subject: { domain: 'asset', id: guid },
    execution: { state: 'ready' },
    lifecycle: { state: 'current' },
    projection: {
      current: { packageUrl: `current-${observedAt}` },
      lastKnownGood: { packageUrl: `lkg-${observedAt}` },
    },
    authoring: {
      placement: { operation: 'spawnEntity' },
      binding: { operation: 'unavailable', reason: { code: 'missing-producer-capability', hint: 'fixture' } },
    },
  } as unknown as CatalogEntry;
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

describe('AssetBrowserReadModel full Catalog projection', () => {
  it('preserves every producer fact and only replaces the affected GUID', async () => {
    const first = catalogEntry('GUID-ONE', 1);
    const stable = catalogEntry('GUID-STABLE', 1);
    let snapshot = { version: 1, entries: [first, stable], stale: false, diagnostics: [] };
    const listeners = new Set<(delta: CatalogDelta) => void>();
    const registry: AssetBrowserRegistry = {
      listCatalog: () => { throw new Error('incremental Catalog snapshot is required'); },
      catalogSnapshot: () => snapshot,
      subscribeCatalog: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const model = createAssetBrowserReadModel({
      registry,
      resolveGamePath: (path) => path ? `/game/${path}` : '/game',
      catalogRoots: [{ root: 'assets', catalogPrefix: 'catalog/assets' }],
      fetch: async (path) => path.startsWith('/api/files/tree')
        ? response({ tree: { type: 'dir', name: 'assets', path: '/game/assets', children: [] } })
        : response({}, 404),
    });

    await model.refresh();
    const before = model.snapshot();
    const stableBefore = before.assets.find((asset) => asset.guid === 'guid-stable');
    const replacement = catalogEntry('GUID-ONE', 2);
    snapshot = { version: 2, entries: [replacement, stable], stale: false, diagnostics: [] };
    for (const listener of listeners) listener({ added: [], changed: [replacement], removed: [] });

    const after = model.snapshot();
    const replaced = after.assets.find((asset) => asset.guid === 'guid-one');
    const stableAfter = after.assets.find((asset) => asset.guid === 'guid-stable');
    expect(replaced).toMatchObject({
      guid: 'guid-one',
      packageId: 'package-GUID-ONE',
      provenance: first.provenance,
      catalogRevision: replacement.revision,
      sourceKey: first.sourceKey,
      sourceOverrides: first.sourceOverrides,
      sourceOverrideDescriptors: first.sourceOverrideDescriptors,
      relations: first.relations,
      diagnostics: first.diagnostics,
      lifecycle: first.lifecycle,
      projection: replacement.projection,
      authoring: first.authoring,
    });
    expect(stableAfter).toBe(stableBefore);
    expect(after.generation).toBe(before.generation);
    expect(after.assets.map((asset) => asset.guid)).toEqual(['guid-one', 'guid-stable']);
  });

  it('fills retained LKG from the lossless registry projection when the replica row omits it', async () => {
    const replicaRow = catalogEntry('GUID-LKG', 2);
    const replicaWithoutLkg = {
      ...replicaRow,
      projection: { current: { packageUrl: 'current-2' } },
    } as unknown as CatalogEntry;
    const registry: AssetBrowserRegistry = {
      listCatalog: () => [replicaRow] as never,
      catalogSnapshot: () => ({ version: 2, entries: [replicaWithoutLkg], stale: false, diagnostics: [] }),
    };
    const model = createAssetBrowserReadModel({
      registry,
      resolveGamePath: (path) => path ? `/game/${path}` : '/game',
      catalogRoots: [{ root: 'assets', catalogPrefix: 'catalog/assets' }],
      fetch: async (path) => path.startsWith('/api/files/tree')
        ? response({ tree: { type: 'dir', name: 'assets', path: '/game/assets', children: [] } })
        : response({}, 404),
    });

    const snapshot = await model.refresh();
    expect(snapshot.assets[0]?.projection?.lastKnownGood).toEqual({ packageUrl: 'lkg-2' });
  });
});
