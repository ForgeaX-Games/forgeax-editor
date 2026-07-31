import { describe, expect, it } from 'bun:test';
import { cookFbxMeta, cookGltfMeta } from '@forgeax/editor-core';

async function fixture(path: string): Promise<ArrayBuffer> {
  return Bun.file(new URL(path, import.meta.url)).arrayBuffer();
}

describe('R0-04H real importer cooker matrix', () => {
  it('cooks the checked-in glTF sample and emits a scene identity', async () => {
    const bytes = await fixture('../../engine/forgeax-engine-assets/khronos-gltf-samples/BoxTextured/BoxTextured.glb');
    const result = await cookGltfMeta(bytes, 'BoxTextured.glb');
    expect(result.ok).toBe(true);
    const meta = JSON.parse(result.metaJson ?? '{}') as { importer?: string; subAssets?: Array<{ kind?: string }> };
    expect(meta.importer).toBe('gltf');
    expect(meta.subAssets).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'scene' })]));
  });

  it('turns malformed glTF and FBX source into structured cook failures', async () => {
    const malformed = new TextEncoder().encode('not-a-real-source').buffer as ArrayBuffer;
    const gltf = await cookGltfMeta(malformed, 'broken.glb');
    expect(gltf.ok).toBe(false);
    expect(gltf.error).toMatch(/gltf-(malformed|parse)/);

    const fbx = await cookFbxMeta(malformed, 'broken.fbx');
    expect(fbx.ok).toBe(false);
    expect(fbx.error).toBeTruthy();
  });
});
