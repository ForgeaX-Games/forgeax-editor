import { describe, expect, it } from 'bun:test';
import type { CatalogDelta, CatalogEntry } from '@forgeax/engine-types';
import { createAssetBrowserReadModel, type AssetBrowserRegistry } from '../assets/asset-browser-read-model';
import { EditGateway } from '../io/gateway';

function entry(guid: string, observedAt: number): CatalogEntry {
  return {
    guid,
    packageUrl: `assets/${guid}.pack.json`,
    sourcePath: `assets/${guid}.glb`,
    kind: 'mesh',
    name: guid,
    revision: { digest: `digest-${observedAt}`, observedAt, rootId: 'gap-root' },
    sourceKey: 'mesh:0',
    refs: [],
  } as CatalogEntry;
}

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('AssetBrowserReadModel Catalog gap recovery', () => {
  it('marks a degraded delta stale without clearing context, then restores the same GUID/revision set', async () => {
    const first = entry('guid-one', 1);
    const stable = entry('guid-stable', 1);
    let catalog = { version: 1, entries: [first, stable], stale: false, diagnostics: [] };
    const listeners = new Set<(delta: CatalogDelta) => void>();
    let reconciles = 0;
    const registry: AssetBrowserRegistry = {
      listCatalog: () => { throw new Error('the immutable Catalog snapshot is required'); },
      catalogSnapshot: () => catalog,
      subscribeCatalog: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      reconcileCatalog: async () => {
        reconciles += 1;
        catalog = { version: 2, entries: [entry('guid-one', 2), stable], stale: false, diagnostics: [] };
        return catalog;
      },
    };
    const model = createAssetBrowserReadModel({
      registry,
      resolveGamePath: (path) => path ? `/game/${path}` : '/game',
      catalogRoots: [],
      fetch: async (path) => path.includes('/tree')
        ? response({ tree: { type: 'dir', name: 'assets', path: '/game/assets', children: [] } })
        : response({}),
    });

    await model.refresh();
    const before = model.snapshot();
    const stableBefore = before.assets.find((asset) => asset.guid === 'guid-stable');
    for (const listener of listeners) listener({ added: [], changed: [], removed: [], authority: 'degraded' });
    const stale = model.snapshot();
    expect(stale.catalogStale).toBe(true);
    expect(stale.reconcileRequired).toBe(true);
    expect(stale.assets.map((asset) => asset.guid)).toEqual(['guid-one', 'guid-stable']);
    expect(stale.assets.find((asset) => asset.guid === 'guid-stable')).toBe(stableBefore);

    const recovered = await model.reconcile();
    expect(reconciles).toBe(1);
    expect(recovered.catalogStale).toBe(false);
    expect(recovered.reconcileRequired).toBe(false);
    expect(recovered.assets.map((asset) => [asset.guid, asset.catalogRevision?.observedAt])).toEqual([
      ['guid-one', 2],
      ['guid-stable', 1],
    ]);
    expect(recovered.assets.find((asset) => asset.guid === 'guid-stable')).not.toBeUndefined();
  });

  it('keeps a stale timeout recoverable and does not submit Meta or clear the browser rows', async () => {
    const observedPaths: string[] = [];
    let stale = true;
    const only = entry('guid-timeout', 7);
    const registry: AssetBrowserRegistry = {
      listCatalog: () => { throw new Error('the immutable Catalog snapshot is required'); },
      catalogSnapshot: () => ({ version: stale ? 7 : 8, entries: [only], stale, diagnostics: [] }),
      reconcileCatalog: async () => { stale = false; return { version: 8, entries: [only], stale: false, diagnostics: [] }; },
    };
    const model = createAssetBrowserReadModel({
      registry,
      resolveGamePath: () => '/game',
      catalogRoots: [],
      fetch: async (path) => {
        observedPaths.push(path);
        return path.includes('/tree')
          ? response({ tree: { type: 'dir', name: 'assets', path: '/game/assets', children: [] } })
          : response({});
      },
    });
    await model.refresh();
    const staleSnapshot = model.snapshot();
    expect(staleSnapshot.catalogStale).toBe(true);
    expect(staleSnapshot.assets.map((asset) => asset.guid)).toEqual(['guid-timeout']);
    const recovered = await model.reconcile();
    expect(observedPaths.every((path) => !path.includes('/meta'))).toBe(true);
    expect(recovered.assets.map((asset) => asset.guid)).toEqual(['guid-timeout']);
    expect(recovered.catalogStale).toBe(false);
  });

  it('routes the existing replica reconcile through catalog.reconcile without Meta writes', async () => {
    let metaWrites = 0;
    let reconcileCalls = 0;
    const registry: AssetBrowserRegistry = {
      listCatalog: () => { throw new Error('the immutable Catalog snapshot is required'); },
      catalogSnapshot: () => ({
        version: 9,
        entries: [],
        stale: true,
        diagnostics: [{ code: 'gap', severity: 'blocking' }],
      }),
      reconcileCatalog: async () => {
        reconcileCalls += 1;
        return {
          version: 10,
          entries: [],
          stale: false,
          diagnostics: [{ code: 'recovered', severity: 'info' }],
        };
      },
    };
    const gateway = new EditGateway();
    const unregister = gateway.registerCatalogReconcile(async () => {
      const snapshot = await registry.reconcileCatalog?.();
      return {
        revision: snapshot?.version ?? 0,
        stale: snapshot?.stale ?? true,
        diagnostics: snapshot?.diagnostics ?? [],
      };
    });

    const dispatched = gateway.dispatch({ kind: 'catalog.reconcile', requestId: 'catalog-reconcile-gap-red' }, 'ai');
    expect(dispatched).toMatchObject({ ok: true, result: { operationRun: { status: 'running' } } });
    await expect(gateway.waitOperationRun('catalog-reconcile-gap-red')).resolves.toMatchObject({
      ok: true,
      value: {
        status: 'succeeded',
        result: { revision: 10, stale: false, diagnostics: [{ code: 'recovered' }] },
      },
    });
    expect(reconcileCalls).toBe(1);
    expect(metaWrites).toBe(0);
    unregister();
  });
});
