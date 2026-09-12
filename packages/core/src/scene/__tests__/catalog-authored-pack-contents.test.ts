import { describe, expect, it } from 'bun:test';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { ShaderRegistry, type ShaderRegistryDevice } from '@forgeax/engine-shader';
import {
  catalogAuthoredPackContents,
  scenePackRefsAreAllInline,
} from '../catalog-authored-pack-contents';

function makeRegistry(): AssetRegistry {
  const device: ShaderRegistryDevice = {
    createShaderModule() {
      return {
        ok: true,
        value: undefined,
        unwrap: () => undefined,
        unwrapOr: (fallback: unknown) => fallback,
      } as unknown as ReturnType<ShaderRegistryDevice['createShaderModule']>;
    },
  };
  return new AssetRegistry(new ShaderRegistry({ device, manifestUrl: undefined }));
}

describe('catalogAuthoredPackContents', () => {
  it('catalogs scene assets so loadByGuid can use the ready fast path', async () => {
    const sceneGuid = '11111111-2222-4333-8444-555555555555';
    const registry = makeRegistry();
    const { cataloged, sceneGuid: primary } = catalogAuthoredPackContents(registry, {
      assets: [
        {
          guid: sceneGuid,
          kind: 'scene',
          payload: { kind: 'scene', entities: [] },
        },
      ],
    });
    expect(cataloged).toBe(1);
    expect(primary).toBe(sceneGuid);
    const { AssetGuid } = await import('@forgeax/engine-pack/guid');
    const parsed = AssetGuid.parse(sceneGuid);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const loaded = await registry.loadByGuid(parsed.value);
    expect(loaded.ok).toBe(true);
  });

  it('resolves mounts[].source refs indices before catalog (game-default shape)', async () => {
    const parentGuid = '1036f6f0-d3c2-5f31-9593-3432942d4c93';
    const childGuid = '0f20e111-5b2f-5a77-9a02-2f5d1e9c7a11';
    const registry = makeRegistry();
    catalogAuthoredPackContents(registry, {
      assets: [
        {
          guid: childGuid,
          kind: 'scene',
          payload: {
            kind: 'scene',
            entities: [{ localId: 0, components: { Name: { value: 'Nested' } } }],
          },
        },
        {
          guid: parentGuid,
          kind: 'scene',
          refs: Array.from({ length: 18 }, (_, i) => (i === 17 ? childGuid : `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)),
          payload: {
            kind: 'scene',
            entities: [{ localId: 0, components: { Name: { value: 'Root' } } }],
            mounts: [{ localId: 23, source: 17, memberFirst: 24, memberCount: 2 }],
          },
        },
      ],
    });
    const parentEntry = registry.assetCatalog.get(parentGuid.toLowerCase());
    expect(parentEntry?.payload).toMatchObject({
      kind: 'scene',
      mounts: [{ source: childGuid }],
    });
  });

  it('catalogScenes:false skips scene bodies but still catalogs inline non-scene assets', () => {
    const sceneGuid = '11111111-2222-4333-8444-555555555555';
    const meshGuid = '22222222-3333-4444-8555-666666666666';
    const registry = makeRegistry();
    const { cataloged, sceneGuid: primary } = catalogAuthoredPackContents(
      registry,
      {
        assets: [
          {
            guid: sceneGuid,
            kind: 'scene',
            payload: { kind: 'scene', entities: [] },
          },
          {
            guid: meshGuid,
            kind: 'mesh',
            payload: {
              vertices: [0, 0, 0, 0, 1, 0, 1, 0, 0],
              indices: [0, 1, 2],
            },
          },
        ],
      },
      { catalogScenes: false },
    );
    expect(cataloged).toBe(1);
    expect(primary).toBeUndefined();
    expect(registry.assetCatalog.has(sceneGuid.toLowerCase())).toBe(false);
    expect(registry.assetCatalog.has(meshGuid.toLowerCase())).toBe(true);
  });

  it('scenePackRefsAreAllInline is false when refs point outside the pack', () => {
    const sceneGuid = '11111111-2222-4333-8444-555555555555';
    const externalMesh = 'c35cf58b-6da2-41e3-960f-3cfb3460b1b7';
    const pack = {
      assets: [
        {
          guid: sceneGuid,
          kind: 'scene',
          refs: [externalMesh],
          payload: { kind: 'scene', entities: [] },
        },
      ],
    };
    expect(scenePackRefsAreAllInline(pack, pack.assets[0])).toBe(false);
  });
});
