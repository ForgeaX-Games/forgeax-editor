// w13 - AssetRegistry Node path (loadByGuid + GUID-keyed dual-layer API).
//
// Migration from load(url) to loadByGuid (feat-20260513-guid-asset-package-system w13).
// Covers registerWithGuid + loadByGuid ok path + resolveGuid idempotency
// + asset-not-found error path on missing GUID.
//
// Original load(url) error paths (asset-fetch-failed / asset-parse-failed /
// asset-format-unsupported) are removed: loadByGuid v1 is a Map lookup
// with no network fetch; those paths will be re-added in M4 when real
// fetch-from-pack-index is implemented.
//
// asset-not-found is kept: get(unregistered handle) path is unaffected.

import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { Handle, TextureAsset, MeshAsset as TypesMeshAsset } from '@forgeax/engine-types';
import { toUnmanaged } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

import { AssetRegistry } from '../asset-registry';
import { createDefaultLoaderRegistry } from '../wire-default-loaders';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const GUID_DAWN_A = '00000000-0000-7000-8000-000000000031';
const GUID_DAWN_B = '00000000-0000-7000-8000-000000000032';

function makeMesh(): TypesMeshAsset {
  return {
    kind: 'mesh',
    // 1 vertex * 12F canonical layout (position vec3 + normal vec3 + uv vec2 + tangent vec4)
    vertices: new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1]),
    indices: new Uint16Array([0]),
    attributes: {},
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 1,
        vertexCount: 12,
        topology: 'triangle-list',
      },
    ],
  };
}

describe('w13 - AssetRegistry Node loadByGuid happy path', () => {
  it('loadByGuid() returns Ok(Handle) for a registered GUID', async () => {
    const reg = new AssetRegistry(makeMockShaderRegistry(), createDefaultLoaderRegistry());
    const parseResult = AssetGuid.parse(GUID_DAWN_A);
    if (!parseResult.ok) throw new Error('expected ok');
    const guid = parseResult.value;
    const mesh = makeMesh();
    reg.registerWithGuid<TypesMeshAsset>(guid, mesh);
    const res = await reg.loadByGuid<TypesMeshAsset>(guid);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const handle: Handle<'MeshAsset', 'unmanaged'> = res.value;
    const got = reg.get<TypesMeshAsset>(handle);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.kind).toBe('mesh');
  });

  it('two loadByGuid(sameGuid) calls return same Handle (idempotent)', async () => {
    const reg = new AssetRegistry(makeMockShaderRegistry(), createDefaultLoaderRegistry());
    const parseResult = AssetGuid.parse(GUID_DAWN_A);
    if (!parseResult.ok) throw new Error('expected ok');
    const guid = parseResult.value;
    reg.registerWithGuid<TypesMeshAsset>(guid, makeMesh());
    const a = await reg.loadByGuid<TypesMeshAsset>(guid);
    const b = await reg.loadByGuid<TypesMeshAsset>(guid);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.value).toBe(b.value);
    }
  });
});

describe('w13 - AssetRegistry Node error paths (AC-03 migration)', () => {
  it('asset-not-found: loadByGuid(unregistered guid)', async () => {
    const reg = new AssetRegistry(makeMockShaderRegistry(), createDefaultLoaderRegistry());
    const parseResult = AssetGuid.parse(GUID_DAWN_B);
    if (!parseResult.ok) throw new Error('expected ok');
    const guid = parseResult.value;
    const res = await reg.loadByGuid<TypesMeshAsset>(guid);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('asset-not-found');
  });

  it('asset-not-found: get(unregistered handle)', () => {
    const reg = new AssetRegistry(makeMockShaderRegistry(), createDefaultLoaderRegistry());
    const fake = toUnmanaged<'TextureAsset'>(0xdeadbeef);
    const res = reg.get<TextureAsset>(fake);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('asset-not-found');
  });
});
