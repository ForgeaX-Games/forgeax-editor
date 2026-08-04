import { describe, expect, it } from 'bun:test';
import { createAssetBrowserReadModel, type AssetBrowserRegistry, type AssetBrowserTreeNode } from '../assets/asset-browser-read-model';

const tree: AssetBrowserTreeNode = {
  type: 'dir', name: 'assets', path: '/game/assets', children: [
    { type: 'file', name: 'Fox.glb', path: '/game/assets/Fox.glb' },
    { type: 'file', name: 'Fox.glb.meta.json', path: '/game/assets/Fox.glb.meta.json' },
    { type: 'dir', name: 'nested', path: '/game/assets/nested', children: [
      { type: 'file', name: 'only.txt', path: '/game/assets/nested/only.txt' },
    ] },
  ],
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function makeModel(options: {
  rows?: readonly Record<string, unknown>[];
  meta?: unknown;
  refreshCatalog?: () => Promise<boolean>;
  treeValue?: AssetBrowserTreeNode | null;
  fetchImpl?: (path: string, init?: RequestInit) => Promise<Response>;
}) {
  const calls: string[] = [];
  const registry: AssetBrowserRegistry = {
    listCatalog: () => (options.rows ?? []) as never,
    ...(options.refreshCatalog ? { refreshCatalog: options.refreshCatalog } : {}),
  };
  const model = createAssetBrowserReadModel({
    registry,
    resolveGamePath: (path) => path ? `/game/${path}` : '/game',
    catalogRoots: [{ root: 'assets', catalogPrefix: 'catalog/assets' }],
    fetch: async (path, init) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (options.fetchImpl) return options.fetchImpl(path, init);
      if (path.startsWith('/api/files/tree')) return response({ tree: options.treeValue ?? tree });
      if (path.includes('Fox.glb.meta.json')) return response(options.meta ?? {
        kind: 'external-asset-package', source: 'Fox.glb', subAssets: [{ guid: 'GUID-SIDECAR', kind: 'mesh' }],
      });
      return response({}, 404);
    },
  });
  return { model, calls };
}

describe('AssetBrowserSnapshot read model (M2)', () => {
  it('deduplicates catalog GUIDs and keeps sidecar-only GUIDs out of assets', async () => {
    const { model } = makeModel({ rows: [
      { guid: 'GUID-CATALOG', kind: 'mesh', packageUrl: 'catalog/assets/Fox.glb.pack.json', sourcePath: 'catalog/assets/Fox.glb' },
      { guid: 'guid-catalog', kind: 'mesh', packageUrl: 'catalog/assets/duplicate.pack.json' },
    ] });
    const snapshot = await model.refresh();
    expect(snapshot.assets.map(asset => asset.guid)).toEqual(['guid-catalog']);
    expect(snapshot.assets[0]?.storagePackageUrl).toBe('catalog/assets/Fox.glb.pack.json');
    expect(snapshot.assets[0]?.storageSourcePath).toBe('catalog/assets/Fox.glb');
    expect(snapshot.assets[0]?.authoring).toBeUndefined();
    expect(snapshot.sources).toContainEqual(expect.objectContaining({ sourcePath: 'assets/Fox.glb', phase: 'indexed' }));
    expect(snapshot.assets.some(asset => asset.guid === 'guid-sidecar')).toBe(false);
  });

  it('projects producer-owned authoring capability without interpreting the asset kind', async () => {
    const authoring = {
      placement: { operation: 'spawnEntity' as const },
      binding: { operation: 'unavailable' as const, reason: { code: 'missing-producer-capability' as const, hint: 'provider-owned' } },
    };
    const { model } = makeModel({ rows: [
      { guid: 'GUID-CUSTOM', kind: 'host/new-kind', packageUrl: 'catalog/assets/custom.pack.json', authoring },
    ] });
    const snapshot = await model.refresh();
    expect(snapshot.assets[0]?.authoring).toEqual(authoring);
  });

  it('projects producer relations into the shared workspace and ignores stale refs', async () => {
    const { model } = makeModel({
      treeValue: { type: 'dir', name: 'game', path: '/game', children: [] },
      rows: [
        { guid: 'GUID-MATERIAL', kind: 'material', packageUrl: 'material.pack.json' },
        {
          guid: 'GUID-SCENE', kind: 'scene', packageUrl: 'scene.pack.json', refs: ['stale-target'],
          relations: [{
            from: { type: 'asset', id: 'GUID-SCENE' },
            to: { type: 'asset', id: 'GUID-MATERIAL' },
            type: 'references',
            provenance: { provider: 'pack', version: '2.0.0' },
          }],
        },
      ],
    });

    const snapshot = await model.refresh();

    expect(snapshot.workspace?.relations).toEqual([
      { kind: 'depends-on', from: 'guid-scene', to: 'guid-material' },
    ]);
  });

  it('reports pending, indexed, raw, and invalid-meta source states', async () => {
    const pending = makeModel({ rows: [], meta: {
      kind: 'external-asset-package', source: 'Fox.glb', subAssets: [{ guid: 'GUID-PENDING', kind: 'mesh' }],
    } });
    expect((await pending.model.refresh()).sources).toContainEqual(expect.objectContaining({ phase: 'pending-index' }));

    const raw = makeModel({ rows: [] , treeValue: { type: 'dir', name: 'assets', path: '/game/assets', children: [
      { type: 'file', name: 'Raw.bin', path: '/game/assets/Raw.bin' },
    ] } });
    expect((await raw.model.refresh()).sources).toContainEqual(expect.objectContaining({ sourcePath: 'assets/Raw.bin', phase: 'raw' }));

    const invalid = makeModel({ rows: [], meta: { kind: 'external-asset-package', source: 'Fox.glb', subAssets: 'bad' } });
    const invalidSnapshot = await invalid.model.refresh();
    expect(invalidSnapshot.diagnostics[0]?.code).toBe('INVALID_META');
    expect(invalidSnapshot.sources).toContainEqual(expect.objectContaining({ phase: 'invalid-meta' }));
  });

  it('materializes a meta-defined UI asset when the runtime catalog has not emitted it yet', async () => {
    const { model } = makeModel({
      rows: [],
      treeValue: { type: 'dir', name: 'assets', path: '/game/assets', children: [
        { type: 'file', name: 'hud.ui.html', path: '/game/assets/ui/hud.ui.html' },
        { type: 'file', name: 'hud.meta.json', path: '/game/assets/ui/hud.meta.json' },
      ] },
      fetchImpl: async (path) => path.startsWith('/api/files/tree')
        ? response({ tree: { type: 'dir', name: 'assets', path: '/game/assets', children: [
          { type: 'file', name: 'hud.ui.html', path: '/game/assets/ui/hud.ui.html' },
          { type: 'file', name: 'hud.meta.json', path: '/game/assets/ui/hud.meta.json' },
        ] } })
        : path.includes('hud.meta.json')
          ? response({ kind: 'external-asset-package', importer: 'ui', source: 'hud.ui.html', subAssets: [{ guid: 'GUID-UI', kind: 'ui' }] })
          : response({}, 404),
    });
    const snapshot = await model.refresh();
    expect(snapshot.assets).toContainEqual(expect.objectContaining({
      guid: 'guid-ui', kind: 'ui', sourcePath: 'assets/ui/hud.ui.html', storagePackageUrl: 'assets/ui/hud.meta.json',
    }));
    expect(snapshot.sources).toContainEqual(expect.objectContaining({ sourcePath: 'assets/ui/hud.ui.html', phase: 'indexed' }));
  });

  it('drops stale generations and directory-only refreshes do not refresh the catalog', async () => {
    let catalogRefreshes = 0;
    let resolveFirstTree!: (value: Response) => void;
    let resolveSecondTree!: (value: Response) => void;
    const firstTree = new Promise<Response>(resolve => { resolveFirstTree = resolve; });
    const secondTree = new Promise<Response>(resolve => { resolveSecondTree = resolve; });
    let treeCalls = 0;
    const { model } = makeModel({
      rows: [],
      refreshCatalog: async () => { catalogRefreshes += 1; return true; },
      fetchImpl: async (path) => {
        if (path.startsWith('/api/files/tree')) {
          treeCalls += 1;
          return treeCalls === 1 ? firstTree : secondTree;
        }
        return response({}, 404);
      },
    });
    const stale = model.refresh();
    const fresh = model.refresh();
    resolveSecondTree(response({ tree: { type: 'dir', name: 'assets', path: '/game/assets', children: [] } }));
    await fresh;
    resolveFirstTree(response({ tree }));
    const staleResult = await stale;
    expect(staleResult.generation).toBe(2);
    expect(model.snapshot().generation).toBe(2);
    const before = catalogRefreshes;
    await model.refresh('directory-only');
    expect(catalogRefreshes).toBe(before);
  });
});
