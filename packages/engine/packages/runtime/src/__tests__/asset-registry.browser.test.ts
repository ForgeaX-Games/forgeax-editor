// w12 - AssetRegistry browser path (loadByGuid + GUID-keyed dual-layer API)
//
// Migration from load(url) to loadByGuid (feat-20260513-guid-asset-package-system w13).
// Covers registerWithGuid + loadByGuid ok path + resolveGuid idempotency
// + AC-11 inspect() shape for a GUID-registered asset handle.

import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { Handle, MeshAsset as TypesMeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

import { AssetRegistry } from '../asset-registry';
import { createDefaultLoaderRegistry } from '../wire-default-loaders';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const GUID_BROWSER_A = '00000000-0000-7000-8000-000000000021';

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

describe('w12 - AssetRegistry browser loadByGuid happy path', () => {
  it('loadByGuid() returns Ok(Handle) for a registered GUID', async () => {
    const reg = new AssetRegistry(makeMockShaderRegistry(), createDefaultLoaderRegistry());
    const parseResult = AssetGuid.parse(GUID_BROWSER_A);
    if (!parseResult.ok) throw new Error('expected ok');
    const guid = parseResult.value;
    const mesh = makeMesh();
    reg.registerWithGuid<TypesMeshAsset>(guid, mesh);
    const res = await reg.loadByGuid<TypesMeshAsset>(guid);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const handle: Handle<'MeshAsset', 'unmanaged'> = res.value;
    expect(typeof handle).toBe('number');
    const got = reg.get<TypesMeshAsset>(handle);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.kind).toBe('mesh');
  });

  it('two loadByGuid(sameGuid) calls return the same Handle', async () => {
    const reg = new AssetRegistry(makeMockShaderRegistry(), createDefaultLoaderRegistry());
    const parseResult = AssetGuid.parse(GUID_BROWSER_A);
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

  it('AC-11: inspect() reports MeshAsset brand after registerWithGuid()', async () => {
    const reg = new AssetRegistry(makeMockShaderRegistry(), createDefaultLoaderRegistry());
    const before = reg.inspect().handles.length;
    const parseResult = AssetGuid.parse(GUID_BROWSER_A);
    if (!parseResult.ok) throw new Error('expected ok');
    const guid = parseResult.value;
    reg.registerWithGuid<TypesMeshAsset>(guid, makeMesh());
    const snap = reg.inspect();
    expect(snap.handles.length).toBe(before + 1);
    const last = snap.handles[snap.handles.length - 1];
    expect(last).toBeDefined();
    if (last === undefined) return;
    expect(last.brand).toBe('MeshAsset');
    expect(last.refcount).toBe('immortal');
  });
});
