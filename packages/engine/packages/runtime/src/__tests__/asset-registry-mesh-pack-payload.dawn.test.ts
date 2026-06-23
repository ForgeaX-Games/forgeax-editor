// asset-registry-mesh-pack-payload.dawn.test.ts - bug-20260523-mesh-upload-floats-per-vertex-fail-fast-and-cascadi
// M3 / t9 (dawn integration): pack deserialization non-12F mesh gate trigger.
//
// Exercises the loadByGuid entrance point (registerWithGuid + parseAssetPayload)
// with a deliberately non-12F vertices payload. Verifies that the registerGate
// mesh-vertex-stride-mismatch gate fires in the dawn runtime context (dawn.node
// GPU device available), not just the node unit-test context.
//
// Cases covered:
// (a) register() non-12F mesh -> Result.err mesh-vertex-stride-mismatch
//     (dawn context; gate already exercised by t4 unit; dawn here adds
//     GPU device wiring awareness)
// (b) registerWithGuid() non-12F mesh -> throws AssetError with
//     code='mesh-vertex-stride-mismatch' (the loadByGuid entrance point;
//     parseAssetPayload produces the MeshAsset, registerWithGuid stores
//     it, and registerWithGuid now validates stride before storing)
// (c) after registerWithGuid throws, resolveGuid returns
//     asset-not-found (AC-03 no-intermediate-state for GUID path)
// (d) AC-08 narrowing: catch AssetError, access detail.floatsPerVertex
//
// Anchors: plan-strategy D-2 (registerWithGuid covered by gate);
//          plan-strategy D-4 (parseAssetPayload not front-loading check,
//            registerWithGuid gate is the enforcement point);
//          plan-strategy R-3 (pack-payload non-12F regression safety);
//          requirements AC-06 (cascading exhaustive);
//          charter P3 (structured failure: .code / .expected / .hint / .detail).

import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { CubeTextureAsset, MeshAsset as TypesMeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { GpuResourceStore } from '../gpu-resource-store';
import { createDefaultLoaderRegistry } from '../wire-default-loaders';

// feat-20260601-gpu-resource-store-extraction M1: configureGpuDevice moved to
// GpuResourceStore (D-3 registerCube relay). These tests exercise registry-side
// register / loadByGuid + the stride gate; they wire the device onto the store
// to keep the dawn device-acquisition path covered.
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const mockCaps = {
  backendKind: 'webgpu' as const,
  compute: true,
  timestampQuery: false,
  indirectDrawing: false,
  textureCompression: false,
  multiDrawIndirect: false,
  pushConstants: false,
  textureBindingArray: false,
  samplerAliasing: false,
  firstInstanceIndirect: false,
  storageBuffer: true,
  storageTexture: false,
  rgba16floatRenderable: true,
  rg11b10ufloatRenderable: false,
  float32Filterable: false,
  maxColorAttachments: 8,
};

const dawnReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;

const GUID_PACK_TEST = '00000000-0000-7000-8000-000000000033';

function makeNon12FAsset(): TypesMeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array(9), // 3 verts * 3F position-only (not 12F)
    indices: new Uint16Array([0, 1, 2]),
    attributes: {},
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 3,
        vertexCount: 0,
        topology: 'triangle-list',
      },
    ],
  };
}

describe('t9 - pack deserialization non-12F mesh gate trigger (dawn)', () => {
  it.skipIf(!dawnReady)(
    '(a) register() non-12F mesh returns mesh-vertex-stride-mismatch (dawn context with GPU device)',
    async () => {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter === null) return;
      const device = await adapter.requestDevice();

      const reg = new AssetRegistry(makeMockShaderRegistry(), createDefaultLoaderRegistry());
      const gpuStore = new GpuResourceStore();
      gpuStore.configureGpuDevice(
        // biome-ignore lint/suspicious/noExplicitAny: structural rhi device shim
        device as any,
        undefined,
        (pod: CubeTextureAsset) => reg.register(pod),
        mockCaps,
      );

      const result = reg.register(makeNon12FAsset());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('mesh-vertex-stride-mismatch');
        expect(result.error.expected).toContain('12 floats per vertex');
        const d = result.error.detail as { vertexCount: number; floatsPerVertex: number };
        expect(d.vertexCount).toBe(0);
        expect(d.floatsPerVertex).toBe(0.75); // 9 / 12
      }
    },
  );

  it('(b) registerWithGuid() non-12F mesh throws AssetError mesh-vertex-stride-mismatch', () => {
    const reg = new AssetRegistry(makeMockShaderRegistry(), createDefaultLoaderRegistry());
    const parseResult = AssetGuid.parse(GUID_PACK_TEST);
    if (!parseResult.ok) throw new Error('expected ok');
    const guid = parseResult.value;

    let thrownCode: string | undefined;
    let thrownFloatsPerVertex: number | undefined;
    try {
      reg.registerWithGuid<TypesMeshAsset>(guid, makeNon12FAsset());
    } catch (e: unknown) {
      const ae = e as { code?: string; detail?: Record<string, unknown> };
      thrownCode = ae.code;
      thrownFloatsPerVertex = ae.detail?.floatsPerVertex as number | undefined;
    }
    expect(thrownCode).toBe('mesh-vertex-stride-mismatch');
    expect(thrownFloatsPerVertex).toBe(0.75);
  });

  it('(c) after registerWithGuid throws, resolveGuid returns asset-not-found (no intermediate state)', () => {
    const reg = new AssetRegistry(makeMockShaderRegistry(), createDefaultLoaderRegistry());
    const parseResult = AssetGuid.parse(GUID_PACK_TEST);
    if (!parseResult.ok) throw new Error('expected ok');
    const guid = parseResult.value;

    try {
      reg.registerWithGuid<TypesMeshAsset>(guid, makeNon12FAsset());
    } catch {
      // Expected -- gate fired, GUID not registered.
    }

    const resolved = reg.resolveGuid<TypesMeshAsset>(guid);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error.code).toBe('asset-not-found');
    }
  });

  it('(d) AC-08 narrowing: catch thrown AssetError and access detail.floatsPerVertex', () => {
    const reg = new AssetRegistry(makeMockShaderRegistry(), createDefaultLoaderRegistry());
    const parseResult = AssetGuid.parse(GUID_PACK_TEST);
    if (!parseResult.ok) throw new Error('expected ok');
    const guid = parseResult.value;

    // vertices.length=11 (not divisible by 12) -> detail.floatsPerVertex = 11/12
    const nonDivisibleAsset: TypesMeshAsset = {
      kind: 'mesh',
      vertices: new Float32Array(11),
      indices: new Uint16Array([0, 1, 2]),
      attributes: {},
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 0,
          topology: 'triangle-list',
        },
      ],
    };

    let caught = false;
    try {
      reg.registerWithGuid<TypesMeshAsset>(guid, nonDivisibleAsset);
    } catch (e: unknown) {
      caught = true;
      const ae = e as { code: string; detail?: Record<string, unknown> };
      expect(ae.code).toBe('mesh-vertex-stride-mismatch');
      const d = ae.detail as { vertexCount: number; floatsPerVertex: number };
      expect(typeof d.vertexCount).toBe('number');
      expect(typeof d.floatsPerVertex).toBe('number');
      expect(d.floatsPerVertex).not.toBe(12);
    }
    expect(caught).toBe(true);
  });

  it.skipIf(!dawnReady)(
    '(e) compliant 12F mesh registerWithGuid + loadByGuid in dawn context returns ok',
    async () => {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter === null) return;
      const device = await adapter.requestDevice();

      const reg = new AssetRegistry(makeMockShaderRegistry(), createDefaultLoaderRegistry());
      const gpuStore = new GpuResourceStore();
      gpuStore.configureGpuDevice(
        // biome-ignore lint/suspicious/noExplicitAny: structural rhi device shim
        device as any,
        undefined,
        (pod: CubeTextureAsset) => reg.register(pod),
        mockCaps,
      );

      const parseResult = AssetGuid.parse(GUID_PACK_TEST);
      if (!parseResult.ok) throw new Error('expected ok');
      const guid = parseResult.value;

      const validAsset: TypesMeshAsset = {
        kind: 'mesh',
        vertices: new Float32Array(36), // 3 verts * 12F
        indices: new Uint16Array([0, 1, 2]),
        attributes: {},
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 3,
            vertexCount: 0,
            topology: 'triangle-list',
          },
        ],
      };
      reg.registerWithGuid<TypesMeshAsset>(guid, validAsset);

      const res = await reg.loadByGuid<TypesMeshAsset>(guid);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(typeof res.value).toBe('number');
    },
  );
});
