import { describe, expect, it } from 'bun:test';
import { cookFbxMeta, cookGltfMeta, mergeFbxImportSettings } from '@forgeax/editor-core';

async function fixture(path: string): Promise<ArrayBuffer> {
  return Bun.file(new URL(path, import.meta.url)).arrayBuffer();
}

type CookedMeta = {
  readonly subAssets: Array<{
    readonly kind: string;
    readonly guid: string;
    readonly sourceKey?: string;
  }>;
  readonly sourceOverrides?: Readonly<Record<string, {
    readonly materialSlots?: readonly {
      readonly slotName?: string;
      readonly sourceKey?: string;
      readonly defaultMaterialGuid?: string;
    }[];
  }>>;
};

function expectMeshDefaultMaterialTopology(meta: CookedMeta): void {
  const mesh = meta.subAssets.find((entry) => entry.kind === 'mesh');
  const material = meta.subAssets.find((entry) => entry.kind === 'material');
  expect(mesh?.sourceKey).toEqual(expect.any(String));
  expect(material?.guid).toEqual(expect.any(String));
  expect(material?.sourceKey).toEqual(expect.any(String));
  const slots = mesh?.sourceKey === undefined
    ? undefined
    : meta.sourceOverrides?.[mesh.sourceKey]?.materialSlots;
  expect(slots).toEqual(expect.arrayContaining([
    expect.objectContaining({
      slotName: expect.any(String),
      sourceKey: material?.sourceKey,
      defaultMaterialGuid: material?.guid,
    }),
  ]));
}

describe('R0-04H real importer cooker matrix', () => {
  it('cooks the checked-in GLB with mesh-owned default material topology and stable reimport identity', async () => {
    const bytes = await fixture('../../../engine/forgeax-engine-assets/khronos-gltf-samples/BoxTextured/BoxTextured.glb');
    const result = await cookGltfMeta(bytes, 'BoxTextured.glb');
    expect(result.ok).toBe(true);
    const meta = JSON.parse(result.metaJson ?? '{}') as CookedMeta & { importer?: string };
    expect(meta.importer).toBe('gltf');
    expect(meta.subAssets).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'scene' })]));
    expectMeshDefaultMaterialTopology(meta);

    const reimport = await cookGltfMeta(bytes, 'BoxTextured.glb', meta);
    expect(reimport.ok).toBe(true);
    const rebuilt = JSON.parse(reimport.metaJson ?? '{}') as CookedMeta;
    expect(rebuilt.subAssets).toEqual(meta.subAssets);
    expect(rebuilt.sourceOverrides).toEqual(meta.sourceOverrides);
  });

  it('cooks a self-contained .gltf through the same mesh default-material contract', async () => {
    const bytes = await fixture('../../../../apps/standalone/e2e/fixtures/self-contained-default-material.gltf');
    const result = await cookGltfMeta(bytes, 'SampleTriangle.gltf');
    expect(result.ok).toBe(true);
    const meta = JSON.parse(result.metaJson ?? '{}') as CookedMeta & { importer?: string };
    expect(meta.importer).toBe('gltf');
    expectMeshDefaultMaterialTopology(meta);
  });

  it('turns malformed glTF and FBX source into structured cook failures', async () => {
    const malformed = new TextEncoder().encode('not-a-real-source').buffer as ArrayBuffer;
    const gltf = await cookGltfMeta(malformed, 'broken.glb');
    expect(gltf.ok).toBe(false);
    expect(gltf.error).toMatch(/gltf-(malformed|parse)/);

    const fbx = await cookFbxMeta(malformed, 'broken.fbx');
    expect(fbx.ok).toBe(false);
    expect(fbx.code).toBe('FBX_SOURCE_INVALID');
    expect(fbx.error).toBeTruthy();
  });

  it('preserves the FBX dependency closure when a reimport omits a new selection', () => {
    const selected = ['../Textures/body.tga', '../Textures/body_normal.tga'];
    const initialMeta = {
      importSettings: mergeFbxImportSettings(undefined, selected),
    };
    const reimportMeta = {
      importSettings: mergeFbxImportSettings(initialMeta),
    };
    expect(initialMeta.importSettings.fbxCandidatePaths).toEqual([
      '../Textures/body.tga',
      '../Textures/body_normal.tga',
    ]);
    expect(reimportMeta.importSettings?.fbxCandidatePaths).toEqual(initialMeta.importSettings?.fbxCandidatePaths);
  });
});
