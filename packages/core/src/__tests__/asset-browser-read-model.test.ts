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
      { guid: 'GUID-CATALOG', kind: 'mesh', relativeUrl: 'catalog/assets/Fox.glb.pack.json', sourcePath: 'catalog/assets/Fox.glb' },
      { guid: 'guid-catalog', kind: 'mesh', relativeUrl: 'catalog/assets/duplicate.pack.json' },
    ] });
    const snapshot = await model.refresh();
    expect(snapshot.assets.map(asset => asset.guid)).toEqual(['guid-catalog']);
    expect(snapshot.assets[0]?.storageRelativeUrl).toBe('catalog/assets/Fox.glb.pack.json');
    expect(snapshot.assets[0]?.storageSourcePath).toBe('catalog/assets/Fox.glb');
    expect(snapshot.sources).toContainEqual(expect.objectContaining({ sourcePath: 'assets/Fox.glb', phase: 'indexed' }));
    expect(snapshot.assets.some(asset => asset.guid === 'guid-sidecar')).toBe(false);
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
