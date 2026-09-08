import { describe, expect, it } from 'bun:test';
import {
  createSourcePublicationObserver,
  type SourcePublicationCurrent,
  type SourcePublicationObservation,
} from '../source-publication-observer';
import { readRuntimeConsumedCurrent } from '../../viewport/viewport-runtime-bridges';

function current(revision: string, identity = 'asset-guid'): SourcePublicationCurrent {
  return { identity, revision };
}

function target(): SourcePublicationObservation {
  return {
    runId: 'run-1',
    guid: 'asset-guid',
    desiredRevision: 'current:2',
    current: current('current:2'),
  };
}

describe('source publication observer', () => {
  it('reports a revision only after the runtime registry consumes the GUID', async () => {
    const events: string[] = [];
    const registry = {
      assetCatalog: new Map(),
      lookup: () => undefined,
      adoptReloadedMeshMaterialSlots: () => ({ ok: true as const, value: undefined }),
      invalidate: (guid: string) => { events.push(`invalidate:${guid}`); },
      parseGuid: (guid: string) => ({ ok: true as const, value: guid }),
      loadByGuid: async (guid: string) => {
        events.push(`load:${guid}`);
        return { ok: true as const, value: { kind: 'mesh' } };
      },
      catalogSnapshot: () => ({
        version: 2,
        stale: false,
        diagnostics: [],
        entries: [{ guid: 'asset-guid', revision: { digest: 'current:2' } }],
      }),
    };

    await expect(readRuntimeConsumedCurrent(registry as never, 'asset-guid')).resolves.toEqual(current('current:2'));
    expect(events).toEqual(['invalidate:asset-guid', 'load:asset-guid']);
  });

  it('derives a current from imported producer facts when the Catalog has no digest', async () => {
    const registry = {
      assetCatalog: new Map(),
      lookup: () => undefined,
      adoptReloadedMeshMaterialSlots: () => ({ ok: true as const, value: undefined }),
      invalidate: () => {},
      parseGuid: (guid: string) => ({ ok: true as const, value: guid }),
      loadByGuid: async () => ({ ok: true as const, value: { kind: 'mesh' } }),
      catalogSnapshot: () => ({
        version: 2,
        stale: false,
        diagnostics: [],
        entries: [{
          guid: 'asset-guid',
          sourceOverrides: { 'mesh:0': { materialSlotDefaultOverrides: { body: 'material-guid' } } },
          refs: ['material-guid'],
          packageUrl: '/mesh.pack.json',
        }],
      }),
    };

    await expect(readRuntimeConsumedCurrent(registry as never, 'asset-guid')).resolves.toEqual({
      identity: 'asset-guid',
      revision: expect.stringContaining('materialSlotDefaultOverrides'),
    });
  });

  it('hot-patches an already-shared Mesh payload identity after publication', async () => {
    const oldMesh = { kind: 'mesh', materialSlots: [{ slotName: 'Body', defaultMaterial: 'old' }] };
    const freshMesh = { kind: 'mesh', materialSlots: [{ slotName: 'Body', defaultMaterial: 'new' }] };
    const assetCatalog = new Map<string, { payload: unknown }>([['asset-guid', { payload: oldMesh }]]);
    const registry = {
      assetCatalog,
      lookup: () => oldMesh,
      invalidate: () => { assetCatalog.delete('asset-guid'); },
      parseGuid: (guid: string) => ({ ok: true as const, value: guid }),
      loadByGuid: async () => {
        assetCatalog.set('asset-guid', { payload: freshMesh });
        return { ok: true as const, value: freshMesh };
      },
      adoptReloadedMeshMaterialSlots: () => {
        oldMesh.materialSlots = freshMesh.materialSlots;
        assetCatalog.set('asset-guid', { payload: oldMesh });
        return { ok: true as const, value: oldMesh };
      },
      catalogSnapshot: () => ({
        version: 2,
        stale: false,
        diagnostics: [],
        entries: [{ guid: 'asset-guid', revision: { digest: 'current:2' } }],
      }),
    };

    await expect(readRuntimeConsumedCurrent(registry as never, 'asset-guid', true)).resolves.toEqual(current('current:2'));
    expect(oldMesh.materialSlots).toEqual([{ slotName: 'Body', defaultMaterial: 'new' }]);
    expect(assetCatalog.get('asset-guid')?.payload).toBe(oldMesh);
  });

  it('does not adopt live Mesh fields for a general reimport probe', async () => {
    const oldMesh = { kind: 'mesh', materialSlots: [{ slotName: 'Old' }] };
    let adoptions = 0;
    const registry = {
      lookup: () => oldMesh,
      invalidate: () => {},
      parseGuid: (guid: string) => ({ ok: true as const, value: guid }),
      loadByGuid: async () => ({ ok: true as const, value: { kind: 'mesh', materialSlots: [{ slotName: 'Fresh' }] } }),
      adoptReloadedMeshMaterialSlots: () => {
        adoptions += 1;
        return { ok: true as const, value: oldMesh };
      },
      catalogSnapshot: () => ({
        version: 2,
        stale: false,
        diagnostics: [],
        entries: [{ guid: 'asset-guid', revision: { digest: 'current:2' } }],
      }),
    };

    await expect(readRuntimeConsumedCurrent(registry as never, 'asset-guid')).resolves.toEqual(current('current:2'));
    expect(adoptions).toBe(0);
    expect(oldMesh.materialSlots).toEqual([{ slotName: 'Old' }]);
  });

  it('requires Catalog, preview, and runtime to observe the same current', async () => {
    const seen: string[] = [];
    const observer = createSourcePublicationObserver({
      timeoutMs: 20,
      probes: {
        catalog: async (value) => { seen.push(`catalog:${value.current.revision}`); return current(value.current.revision) as never; },
        preview: async (value) => { seen.push(`preview:${value.current.revision}`); return current(value.current.revision) as never; },
        runtime: async (value) => { seen.push(`runtime:${value.current.revision}`); return current(value.current.revision) as never; },
      },
    });
    await expect(observer.observe(target())).resolves.toMatchObject({
      status: 'succeeded',
      desiredRevision: 'current:2',
      current: current('current:2'),
      observations: {
        catalog: current('current:2'),
        preview: current('current:2'),
        runtime: current('current:2'),
      },
    });
    expect(seen).toEqual(['catalog:current:2', 'preview:current:2', 'runtime:current:2']);
  });

  it('retries a transient cross-probe revision race until all consumers converge', async () => {
    let catalogCalls = 0;
    const observer = createSourcePublicationObserver({
      timeoutMs: 100,
      probes: {
        catalog: async () => {
          catalogCalls += 1;
          return current(catalogCalls === 1 ? 'current:2' : 'current:3') as never;
        },
        preview: async () => current('current:3') as never,
        runtime: async () => current('current:3') as never,
      },
    });

    await expect(observer.observe(target())).resolves.toMatchObject({
      status: 'succeeded',
      current: current('current:3'),
    });
    expect(catalogCalls).toBe(2);
  });

  it('reports failed/LKG and observation timeout as recoverable terminal projections', async () => {
    const failed = createSourcePublicationObserver({
      timeoutMs: 20,
      probes: {
        catalog: async (value) => current(value.current.revision) as never,
        preview: async () => false,
        runtime: async (value) => current(value.current.revision) as never,
      },
    });
    await expect(failed.observe({ ...target(), lastKnownGood: current('current:1') })).resolves.toMatchObject({
      status: 'failed',
      lastKnownGood: current('current:1'),
      error: { code: 'asset-cook-failed', recoveryActions: ['run.retry', 'catalog.reconcile'] },
    });

    let release!: () => void;
    const blocked = new Promise<never>((resolve) => { release = () => resolve(undefined as never); });
    const timeout = createSourcePublicationObserver({
      timeoutMs: 1,
      probes: {
        catalog: async () => blocked,
        preview: async (value) => current(value.current.revision) as never,
        runtime: async (value) => current(value.current.revision) as never,
      },
    });
    await expect(timeout.observe(target())).resolves.toMatchObject({
      status: 'observation-timeout',
      error: { code: 'asset-publish-observation-timeout', recoveryActions: ['catalog.reconcile', 'run.retry'] },
    });
    release();
  });

  it('reconciles through the injected probes without creating another current', async () => {
    let reconciles = 0;
    const observer = createSourcePublicationObserver({
      timeoutMs: 20,
      probes: {
        catalog: async (value) => current(value.current.revision) as never,
        preview: async (value) => current(value.current.revision) as never,
        runtime: async (value) => current(value.current.revision) as never,
        reconcile: async () => { reconciles += 1; },
      },
    });
    await expect(observer.reconcile(target())).resolves.toMatchObject({
      status: 'succeeded', current: current('current:2'), desiredRevision: 'current:2',
    });
    expect(reconciles).toBe(1);
  });

  it('rejects an LKG preview even when the target GUID is present', async () => {
    const observer = createSourcePublicationObserver({
      timeoutMs: 20,
      probes: {
        catalog: async (value) => current(value.current.revision) as never,
        preview: async () => current('current:1') as never,
        runtime: async (value) => current(value.current.revision) as never,
      },
    });

    await expect(observer.observe({ ...target(), lastKnownGood: current('current:1') })).resolves.toMatchObject({
      status: 'failed',
      current: current('current:2'),
      lastKnownGood: current('current:1'),
      error: { code: 'asset-cook-failed' },
    });
  });

  it('rejects a runtime consumer with the wrong identity at the target revision', async () => {
    const observer = createSourcePublicationObserver({
      timeoutMs: 20,
      probes: {
        catalog: async (value) => current(value.current.revision) as never,
        preview: async (value) => current(value.current.revision) as never,
        runtime: async (value) => current(value.current.revision, 'other-asset') as never,
      },
    });

    await expect(observer.observe(target())).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'asset-cook-failed' },
    });
  });

  it('stops an in-flight probe when the Gateway run is cancelled', async () => {
    const controller = new AbortController();
    let release!: () => void;
    const blocked = new Promise<never>((resolve) => { release = () => resolve(undefined as never); });
    const observer = createSourcePublicationObserver({
      timeoutMs: 1000,
      probes: {
        catalog: async () => blocked,
        preview: async (value) => current(value.current.revision) as never,
        runtime: async (value) => current(value.current.revision) as never,
      },
    });
    const pending = observer.observe(target(), controller.signal);
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      status: 'observation-timeout',
      error: { code: 'asset-publish-observation-timeout' },
    });
    release();
  });
});
