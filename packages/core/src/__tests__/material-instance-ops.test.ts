import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { hasOp, getOp, listOps } from '../io/catalog';
import { setPathResolver } from '../util/path-resolver';
import {
  applyCreateMaterialInstance,
  applySaveMaterialInstance,
  applySetMaterialInstanceOverride,
  applySetMaterialInstanceParent,
  applySetMaterialInstanceLightmass,
} from '../session/material-instance-ops';
import {
  createDefaultMaterialInstancePayload,
  MATERIAL_INSTANCE_KIND,
} from '../assets/material-instance-schema';
import {
  awaitAuthoredMaterialReady,
  registerPostAssetWriteCatalogSync,
} from '../session/authored-asset-write';
import { panelBridge } from '../io/panel-bridge';

const PARENT = '11111111-1111-4111-8111-111111111111';
const MI = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

beforeEach(() => setPathResolver((relativePath) => relativePath));
afterEach(() => setPathResolver(null));

describe('material-instance op registration', () => {
  for (const id of [
    'createMaterialInstance',
    'saveMaterialInstance',
    'setMaterialInstanceParent',
    'setMaterialInstanceOverride',
    'setMaterialInstanceLightmass',
  ] as const) {
    it(`${id} is a cataloged DOCUMENT op`, () => {
      expect(hasOp(id)).toBe(true);
      expect(getOp(id)?.domain).toBe('document');
      expect(listOps().some((op) => op.id === id)).toBe(true);
    });
  }
});

/** Minimal applier ctx — avoid importing session/document (engine-scene). */
function fakeCtx(written: unknown[]): never {
  return {
    engine: {},
    assetIO: {
      createAssetInPack: async ({ asset }: { asset: unknown }) => {
        written.push({ op: 'create', asset });
        return { ok: true as const };
      },
      writePackEntry: async (_path: string, entry: unknown) => {
        written.push({ op: 'write', entry });
        return true;
      },
    },
    alias: new Map(),
    dispatchSub: () => ({ ok: true, inverse: { kind: 'noop' }, created: [] }),
    query: () => undefined,
  } as never;
}

describe('createMaterialInstance validation (applier)', () => {
  it('missing parentGuid fails with INVALID_ARGS', () => {
    const r = applyCreateMaterialInstance(fakeCtx([]), {
      kind: 'createMaterialInstance',
      guid: MI,
      name: 'MI_Test',
    } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
  });

  it('invalid guid fails with INVALID_ARGS', () => {
    const r = applyCreateMaterialInstance(fakeCtx([]), {
      kind: 'createMaterialInstance',
      guid: 'not-a-guid',
      name: 'MI_Test',
      parentGuid: PARENT,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
  });
});

describe('material-instance appliers', () => {
  it('createMaterialInstance writes kind material-instance with parent in refs', async () => {
    const written: unknown[] = [];
    const r = applyCreateMaterialInstance(fakeCtx(written), {
      kind: 'createMaterialInstance',
      guid: MI,
      name: 'MI_A',
      parentGuid: PARENT,
      packPath: 'assets/materials.pack.json',
      overrides: { metallic: { enabled: true, value: 0.5 } },
    });
    expect(r.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const create = written.find((w) => (w as { op: string }).op === 'create') as {
      asset: { kind: string; payload: { parent: string; overrides: Record<string, unknown> }; refs: string[] };
    };
    expect(create.asset.kind).toBe(MATERIAL_INSTANCE_KIND);
    expect(create.asset.payload.parent).toBe(PARENT);
    expect(create.asset.refs).toContain(PARENT);
    expect(create.asset.payload.overrides.metallic).toEqual({ enabled: true, value: 0.5 });
  });

  // Regression: the applier used to broadcast assetsChanged the moment the pack
  // bytes landed. The Content Browser then refreshed against a pack-index the
  // host watcher had not rebuilt yet, so the new MI was nowhere in the asset
  // tree — the "created but no file anywhere" report. The catalog barrier must
  // run BEFORE the broadcast, exactly like createMaterial.
  it('createMaterialInstance awaits the catalog barrier before broadcasting', async () => {
    const order: string[] = [];
    let releaseBarrier: (() => void) | undefined;
    registerPostAssetWriteCatalogSync((guid) => {
      order.push(`barrier:${guid}`);
      return new Promise<void>((resolve) => { releaseBarrier = resolve; });
    });
    const offBroadcast = panelBridge.on('assetsChanged', () => order.push('assetsChanged'));
    try {
      const r = applyCreateMaterialInstance(fakeCtx([]), {
        kind: 'createMaterialInstance',
        guid: MI,
        name: 'MI_Barrier',
        parentGuid: PARENT,
        packPath: 'assets/Materials.pack.json',
      });
      expect(r.ok).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(order).toEqual([`barrier:${MI}`]);

      releaseBarrier?.();
      const ready = await awaitAuthoredMaterialReady(MI);
      expect(ready.ok).toBe(true);
      expect(order).toEqual([`barrier:${MI}`, 'assetsChanged']);
    } finally {
      offBroadcast();
      registerPostAssetWriteCatalogSync(null);
    }
  });

  it('createMaterialInstance reports a failed pack write through readiness', async () => {
    registerPostAssetWriteCatalogSync(null);
    const ctx = {
      assetIO: {
        createAssetInPack: async () => ({ ok: false as const, reason: 'read-failed', hint: 'pack unreadable' }),
        writePackEntry: async () => true,
      },
    } as never;
    const r = applyCreateMaterialInstance(ctx, {
      kind: 'createMaterialInstance',
      guid: OTHER,
      name: 'MI_Broken',
      parentGuid: PARENT,
      packPath: 'assets/Materials.pack.json',
    });
    expect(r.ok).toBe(true);

    const ready = await awaitAuthoredMaterialReady(OTHER);
    expect(ready.ok).toBe(false);
    if (!ready.ok) {
      expect(ready.stage).toBe('write');
      expect(ready.hint).toContain('pack unreadable');
    }
  });

  it('setMaterialInstanceOverride updates enabled/value and returns inverse', async () => {
    const written: unknown[] = [];
    const payload = createDefaultMaterialInstancePayload(PARENT);
    const oldEntry = {
      guid: MI,
      kind: MATERIAL_INSTANCE_KIND,
      name: 'MI_A',
      payload: payload as unknown as Record<string, unknown>,
      refs: [PARENT],
    };
    const r = applySetMaterialInstanceOverride(fakeCtx(written), {
      kind: 'setMaterialInstanceOverride',
      packPath: 'assets/materials.pack.json',
      guid: MI,
      paramKey: 'roughness',
      enabled: true,
      value: 0.2,
      _oldEntry: oldEntry,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.inverse.kind).toBe('setMaterialInstanceOverride');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const write = written[0] as { entry: { payload: { overrides: Record<string, { enabled: boolean; value: number }> } } };
    expect(write.entry.payload.overrides.roughness).toEqual({ enabled: true, value: 0.2 });
  });

  it('setMaterialInstanceParent rejects cycles', () => {
    const childPayload = createDefaultMaterialInstancePayload(PARENT);
    const miEntry = {
      guid: MI,
      kind: MATERIAL_INSTANCE_KIND,
      payload: childPayload as unknown as Record<string, unknown>,
      refs: [PARENT],
    };
    const otherEntry = {
      guid: OTHER,
      kind: MATERIAL_INSTANCE_KIND,
      payload: createDefaultMaterialInstancePayload(MI) as unknown as Record<string, unknown>,
      refs: [MI],
    };
    const r = applySetMaterialInstanceParent(fakeCtx([]), {
      kind: 'setMaterialInstanceParent',
      packPath: 'assets/materials.pack.json',
      guid: MI,
      parentGuid: OTHER,
      _oldEntry: miEntry,
      _catalogEntries: [otherEntry, { guid: PARENT, kind: 'material', payload: { kind: 'material', values: {} }, refs: [] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.hint).toMatch(/cycle/i);
  });

  it('saveMaterialInstance replaces payload', async () => {
    const written: unknown[] = [];
    const oldPayload = createDefaultMaterialInstancePayload(PARENT);
    const nextPayload = createDefaultMaterialInstancePayload(PARENT, {
      overrides: { baseColor: { enabled: true, value: [1, 0, 0, 1] } },
    });
    const r = applySaveMaterialInstance(fakeCtx(written), {
      kind: 'saveMaterialInstance',
      packPath: 'assets/materials.pack.json',
      guid: MI,
      payload: nextPayload as unknown as Record<string, unknown>,
      _oldEntry: {
        guid: MI,
        kind: MATERIAL_INSTANCE_KIND,
        payload: oldPayload as unknown as Record<string, unknown>,
        refs: [PARENT],
      },
    });
    expect(r.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const write = written[0] as { entry: { payload: { overrides: Record<string, unknown> } } };
    expect(write.entry.payload.overrides.baseColor).toEqual({ enabled: true, value: [1, 0, 0, 1] });
  });

  it('setMaterialInstanceLightmass patches lightmass fields', async () => {
    const written: unknown[] = [];
    const payload = createDefaultMaterialInstancePayload(PARENT);
    const r = applySetMaterialInstanceLightmass(fakeCtx(written), {
      kind: 'setMaterialInstanceLightmass',
      packPath: 'assets/materials.pack.json',
      guid: MI,
      lightmassPatch: { emissiveBoost: 2.5 },
      _oldEntry: {
        guid: MI,
        kind: MATERIAL_INSTANCE_KIND,
        payload: payload as unknown as Record<string, unknown>,
        refs: [PARENT],
      },
    });
    expect(r.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const write = written[0] as { entry: { payload: { lightmass: { emissiveBoost: number } } } };
    expect(write.entry.payload.lightmass.emissiveBoost).toBe(2.5);
  });
});
