// material-hot-update.test.ts — locks the material hot-reload + save fixes.
//
// Two user bugs, one root cause: updateMaterialParams wrote the new params to
// disk and then called invalidateAsset(guid), which ONLY dropped the registry
// catalogue entry. It never touched the LIVE material payload behind the
// world.sharedRef the render extract reads every frame. Consequences:
//   Bug 2 — the viewport kept showing the OLD colour until a full scene reload
//            ("material edits only take effect after a save/reload").
//   Bug 1 — for an inline material the emptied catalogue made the save path
//            re-append the load-time snapshot, clobbering the new colour back to
//            the old. (New-material cataloguing itself is owned by the host's
//            postAssetWriteCatalogSync hook, covered elsewhere.)
//
// The fix keeps disk / registry catalogue / world.sharedRef consistent by
// mutating the SHARED payload object in place (patchLiveMaterialParams). This
// suite pins:
//   A. patchLiveMaterialParams mutates the payload the sharedRef resolves to
//      (identity) AND the catalogue lookup, WITHOUT deleting the entry.
//   B. applyUpdateMaterialParams routes through patchLiveMaterialParams (NOT
//      invalidateAsset) after the pack write resolves, with merged paramValues.

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { ShaderRegistryDevice } from '@forgeax/engine-shader';
import { AssetRegistry, resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { Handle, MaterialAsset } from '@forgeax/engine-types';
import { EngineFacade } from '../io/engine-facade';
import { applyUpdateMaterialParams } from '../session/material-ops';
import type { EditorOp } from '../types';

function makeMockShaderRegistry(): ShaderRegistry {
  const mockDevice: ShaderRegistryDevice = {
    createShaderModule() {
      return {
        ok: true,
        value: undefined,
        unwrap: () => undefined,
        unwrapOr: (d: unknown) => d,
      } as unknown as ReturnType<ShaderRegistryDevice['createShaderModule']>;
    },
  };
  const sr = new ShaderRegistry({ device: mockDevice, manifestUrl: undefined });
  sr.registerMaterialShader('test::dummy', { source: 'fn main() {}', paramSchema: [] });
  return sr;
}

const MATERIAL_GUID = 'cbe42beb-8975-5096-b3a1-3dda4cb4c077';

function makeMaterial(baseColor: number[]): MaterialAsset {
  return {
    kind: 'material',
    passes: [{ name: 'forward', shader: 'test::dummy', tags: { LightMode: 'Forward' } }],
    paramValues: { baseColor },
  } as MaterialAsset;
}

describe('A. patchLiveMaterialParams — hot-update the live sharedRef payload', () => {
  it('mutates the payload the world.sharedRef resolves to, and the catalogue, in place', () => {
    const registry = new AssetRegistry(makeMockShaderRegistry());
    const world = new World();
    const facade = new EngineFacade(world as never, registry);

    const g = AssetGuid.parse(MATERIAL_GUID);
    if (!g.ok) throw new Error('bad test GUID');
    const cat = registry.catalog(g.value, makeMaterial([1, 1, 1, 1]));
    if (!cat.ok) throw new Error(`catalog failed: ${JSON.stringify(cat.error)}`);

    // Mint the sharedRef from the CATALOGUED payload — exactly what
    // asset-registry._resolveSceneGuids does at instantiate (by reference).
    const key = AssetGuid.format(g.value).toLowerCase();
    const payload = registry.assetCatalog.get(key)!.payload;
    const handle = world.allocSharedRef('MaterialAsset', payload);

    facade.patchLiveMaterialParams(MATERIAL_GUID, { baseColor: [0.2, 0.4, 0.6, 1], metallic: 0.5 });

    // The render extract path: resolve the handle → new colour visible NOW.
    const res = resolveAssetHandle<MaterialAsset>(
      world as never,
      handle as unknown as Handle<string, 'shared'>,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const pv = res.value.paramValues as Record<string, unknown>;
      expect(pv.baseColor).toEqual([0.2, 0.4, 0.6, 1]);
      expect(pv.metallic).toBe(0.5);
    }

    // The catalogue lookup (save path: appendInlineAssets → reg.lookup) agrees…
    const looked = registry.lookup<MaterialAsset>(MATERIAL_GUID);
    expect((looked?.paramValues as Record<string, unknown>).baseColor).toEqual([0.2, 0.4, 0.6, 1]);
    // …and the entry is NOT dropped (unlike the old invalidateAsset path).
    expect(registry.assetCatalog.has(key)).toBe(true);
  });

  it('is a graceful no-op for an unknown / non-material GUID', () => {
    const registry = new AssetRegistry(makeMockShaderRegistry());
    const world = new World();
    const facade = new EngineFacade(world as never, registry);
    expect(() => facade.patchLiveMaterialParams('00000000-0000-4000-a000-000000000009', { baseColor: [0, 0, 0, 1] })).not.toThrow();
  });

  // Regression (bug: colour reverts to OLD after Ctrl+S). updateMaterialParams
  // writes fresh bytes to disk, but the registry's packFileCache still holds the
  // LOAD-TIME pack body. A save-triggered scene refresh drops a standalone-pack
  // material's catalogue entry (the scene never references it); the next
  // loadByGuid then re-fetches from that STALE cached body and reverts the colour.
  // patchLiveMaterialParams must evict that cached body so the re-fetch reads the
  // fresh disk bytes — while KEEPING the catalogue entry (unlike invalidate()).
  it('evicts the stale pack-body cache for the material pack, but keeps the catalogue entry', () => {
    const registry = new AssetRegistry(makeMockShaderRegistry());
    const world = new World();
    const facade = new EngineFacade(world as never, registry);

    const g = AssetGuid.parse(MATERIAL_GUID);
    if (!g.ok) throw new Error('bad test GUID');
    const cat = registry.catalog(g.value, makeMaterial([1, 1, 1, 1]));
    if (!cat.ok) throw new Error(`catalog failed: ${JSON.stringify(cat.error)}`);
    const key = AssetGuid.format(g.value).toLowerCase();

    // Mirror the runtime shape: the pack-index maps this GUID → its pack URL
    // (CatalogRecord.packageUrl), and the pack body is cached under that URL.
    const packageUrl = '/preview/.forgeax/games/x/assets/Materials.pack.json';
    registry.packIndexCache = new Map([[key, { packageUrl, kind: 'material' }]]) as never;
    registry.packFileCache.set(packageUrl, { assets: [] } as never);

    facade.patchLiveMaterialParams(MATERIAL_GUID, { baseColor: [0.9, 0.1, 0.1, 1] });

    // The stale body is evicted → next loadByGuid re-fetches fresh disk bytes.
    expect(registry.packFileCache.has(packageUrl)).toBe(false);
    // …but the catalogue entry survives (consecutive edits + _preFillMaterialOp).
    expect(registry.assetCatalog.has(key)).toBe(true);
    expect((registry.lookup<MaterialAsset>(MATERIAL_GUID)!.paramValues as Record<string, unknown>).baseColor)
      .toEqual([0.9, 0.1, 0.1, 1]);
  });
});

describe('B. applyUpdateMaterialParams — hot-patch instead of invalidate', () => {
  it('after the pack write it calls patchLiveMaterialParams with merged params, not invalidateAsset', async () => {
    const patched: { guid: string; params: Record<string, unknown> }[] = [];
    let invalidateCalls = 0;
    const fakeCtx = {
      assetIO: {
        writePackEntry() {
          return Promise.resolve(true);
        },
      },
      engine: {
        patchLiveMaterialParams(guid: string, params: Record<string, unknown>) {
          patched.push({ guid, params });
        },
        invalidateAsset() {
          invalidateCalls += 1;
        },
      },
    } as never;

    const cmd = {
      kind: 'updateMaterialParams',
      packPath: 'games/sample/assets/scene.pack.json',
      guid: MATERIAL_GUID,
      paramPatch: { baseColor: [0.9, 0.1, 0.1, 1] },
      // gateway pre-fill (assetCatalog snapshot) — supplied here directly.
      _oldPatch: { baseColor: [1, 1, 1, 1], roughness: 0.5 },
      _oldEntry: {
        guid: MATERIAL_GUID,
        kind: 'material',
        name: 'M',
        payload: { kind: 'material', passes: [], paramValues: { baseColor: [1, 1, 1, 1], roughness: 0.5 } },
        refs: [],
      },
    } as unknown as EditorOp;

    const r = applyUpdateMaterialParams(fakeCtx, cmd);
    expect(r.ok).toBe(true);

    // The write + patch are a detached microtask chain; let it settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(patched.length).toBe(1);
    expect(patched[0]!.guid).toBe(MATERIAL_GUID);
    // Merged: patched baseColor overrides, untouched roughness survives.
    expect(patched[0]!.params.baseColor).toEqual([0.9, 0.1, 0.1, 1]);
    expect(patched[0]!.params.roughness).toBe(0.5);
    // The stale invalidate path is gone.
    expect(invalidateCalls).toBe(0);
  });
});
