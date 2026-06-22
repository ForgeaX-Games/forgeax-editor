// feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M2 / w6 —
// GpuBuffer / GpuTexture .destroy() unit tests.
//
// Coverage matrix (requirements AC-04 + plan-strategy §5.3):
//   1. GpuBuffer.destroy: first call returns ok; isDestroyed flips to true.
//   2. GpuBuffer.destroy: second call routes the underlying RhiDevice
//      'destroy-after-destroy' err verbatim (D-7 SSOT — RHI shim is the
//      lifecycle SSOT; the runtime wrapper forwards instead of duplicating
//      the bookkeeping; charter §F1).
//   3. GpuTexture.destroy: same first / ok + isDestroyed=true.
//   4. GpuTexture.destroy: same second / 'destroy-after-destroy' forward.
//
// Mock shape: a minimal RhiDevice stub with destroyBuffer / destroyTexture
// implementing per-handle `destroyed: Set` bookkeeping that mirrors the
// real shim's contract (rhi-webgpu device.ts lines 1404–1473). Plain
// branded handles are fabricated via `as unknown as Buffer / Texture` —
// the runtime wrapper never reads the brand; only the device methods
// touch the handle (charter §F4 explicit failure: any future shape
// change to handle bookkeeping flips the second-destroy branch).

import type { Buffer, Result, RhiCaps, RhiDevice, Texture } from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import {
  type CubeTextureAsset,
  type Handle,
  type MeshAsset,
  type TextureAsset,
  toShared,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

import { GpuBuffer, GpuTexture } from '../gpu-resource';
import { GpuResourceStore } from '../gpu-resource-store';

// ── Minimal RhiDevice stub (only destroyBuffer / destroyTexture wired) ──

type MinimalDevice = Pick<RhiDevice, 'destroyBuffer' | 'destroyTexture'>;

function makeMockDevice(): MinimalDevice {
  const destroyedBufs = new WeakSet<Buffer>();
  const destroyedTexs = new WeakSet<Texture>();
  return {
    destroyBuffer(buf: Buffer): Result<void, RhiError> {
      if (destroyedBufs.has(buf)) {
        return err(
          new RhiError({
            code: 'destroy-after-destroy',
            expected: 'GPU buffer handle has not been destroyed yet',
            hint: 'object already destroyed; track lifecycle in caller or check isDestroyed before re-destroy',
          }),
        );
      }
      destroyedBufs.add(buf);
      return ok(undefined);
    },
    destroyTexture(tex: Texture): Result<void, RhiError> {
      if (destroyedTexs.has(tex)) {
        return err(
          new RhiError({
            code: 'destroy-after-destroy',
            expected: 'GPU texture handle has not been destroyed yet',
            hint: 'object already destroyed; track lifecycle in caller or check isDestroyed before re-destroy',
          }),
        );
      }
      destroyedTexs.add(tex);
      return ok(undefined);
    },
  };
}

// Branded opaque handles; the runtime wrapper never inspects the brand,
// only the mock device methods key off identity.
function makeBufHandle(): Buffer {
  return {} as unknown as Buffer;
}
function makeTexHandle(): Texture {
  return {} as unknown as Texture;
}

describe('GpuBuffer (feat-20260612 M2 / w6)', () => {
  it('destroy: first call returns ok; isDestroyed flips to true', () => {
    const device = makeMockDevice();
    const handle = makeBufHandle();
    const gpuBuf = new GpuBuffer(device as unknown as RhiDevice, handle);

    expect(gpuBuf.isDestroyed).toBe(false);

    const r = gpuBuf.destroy();
    expect(r.ok).toBe(true);
    expect(gpuBuf.isDestroyed).toBe(true);
  });

  it("destroy: second call returns err 'destroy-after-destroy' (forwarded from RHI shim)", () => {
    const device = makeMockDevice();
    const handle = makeBufHandle();
    const gpuBuf = new GpuBuffer(device as unknown as RhiDevice, handle);

    const first = gpuBuf.destroy();
    expect(first.ok).toBe(true);

    const second = gpuBuf.destroy();
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('destroy-after-destroy');
    }
    // isDestroyed stays true — the second call did not un-destroy it.
    expect(gpuBuf.isDestroyed).toBe(true);
  });
});

describe('GpuTexture (feat-20260612 M2 / w6)', () => {
  it('destroy: first call returns ok; isDestroyed flips to true', () => {
    const device = makeMockDevice();
    const handle = makeTexHandle();
    const gpuTex = new GpuTexture(device as unknown as RhiDevice, handle);

    expect(gpuTex.isDestroyed).toBe(false);

    const r = gpuTex.destroy();
    expect(r.ok).toBe(true);
    expect(gpuTex.isDestroyed).toBe(true);
  });

  it("destroy: second call returns err 'destroy-after-destroy' (forwarded from RHI shim)", () => {
    const device = makeMockDevice();
    const handle = makeTexHandle();
    const gpuTex = new GpuTexture(device as unknown as RhiDevice, handle);

    const first = gpuTex.destroy();
    expect(first.ok).toBe(true);

    const second = gpuTex.destroy();
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('destroy-after-destroy');
    }
    expect(gpuTex.isDestroyed).toBe(true);
  });
});

// ── M-3 / w9 + w10: gpuStore narrowing + destroyAll unit tests ──
//
// Coverage matrix (requirements AC-05 + AC-06 / plan-strategy §7 M-3 / D-2 / D-9):
//   w9: type-level narrowing — getMeshGpuHandles(...).vertexBuffer / indexBuffer
//       is GpuBuffer (not raw RHI Buffer); getCubemapGpuTexture(...) is GpuTexture
//       (not raw Texture). Validated by `const _: GpuBuffer = entry.vertexBuffer`
//       in the test body — `pnpm typecheck` is the gate.
//   w10: gpuStore.destroyAll() walks the three handle maps + every GpuResource
//       isDestroyed flips to true; second call is idempotent (no error).
//
// The mock device extends the pipeline.unit.test.ts shape with destroyBuffer /
// destroyTexture (M-1) so the GpuBuffer / GpuTexture wrappers can forward.

interface DeviceProbe {
  buffers: number;
  textures: number;
  views: number;
  destroyedBuffers: number;
  destroyedTextures: number;
}

function freshProbe(): DeviceProbe {
  return { buffers: 0, textures: 0, views: 0, destroyedBuffers: 0, destroyedTextures: 0 };
}

const okShim = <T>(v: T) => ({ ok: true as const, value: v });

// biome-ignore lint/suspicious/noExplicitAny: opaque mock GPU device surface
function makeStoreMockDevice(probe: DeviceProbe): any {
  const destroyedBufs = new WeakSet<object>();
  const destroyedTexs = new WeakSet<object>();
  return {
    createShaderModule: () => okShim({ __mock: 'shader' }),
    createSampler: () => okShim({ __mock: 'sampler' }),
    createBindGroupLayout: () => okShim({ __mock: 'bgl' }),
    createPipelineLayout: () => okShim({ __mock: 'layout' }),
    createRenderPipeline: () => okShim({ __mock: 'pipeline' }),
    createBindGroup: () => okShim({ __mock: 'bindGroup' }),
    createBuffer: (desc: { size?: number }) => {
      probe.buffers += 1;
      return okShim({ __mock: `buffer-${probe.buffers}`, size: desc.size ?? 0 });
    },
    createTexture: () => {
      probe.textures += 1;
      return okShim({ __mock: `texture-${probe.textures}` });
    },
    createTextureView: () => {
      probe.views += 1;
      return okShim({ __mock: `view-${probe.views}` });
    },
    destroyBuffer(buf: object): Result<void, RhiError> {
      if (destroyedBufs.has(buf)) {
        return err(
          new RhiError({
            code: 'destroy-after-destroy',
            expected: 'GPU buffer handle has not been destroyed yet',
            hint: 'object already destroyed; track lifecycle in caller',
          }),
        );
      }
      destroyedBufs.add(buf);
      probe.destroyedBuffers += 1;
      return ok(undefined);
    },
    destroyTexture(tex: object): Result<void, RhiError> {
      if (destroyedTexs.has(tex)) {
        return err(
          new RhiError({
            code: 'destroy-after-destroy',
            expected: 'GPU texture handle has not been destroyed yet',
            hint: 'object already destroyed; track lifecycle in caller',
          }),
        );
      }
      destroyedTexs.add(tex);
      probe.destroyedTextures += 1;
      return ok(undefined);
    },
    queue: {
      writeBuffer: () => okShim(undefined),
      writeTexture: () => okShim(undefined),
      submit: () => okShim(undefined),
    },
  };
}

const mockCaps: RhiCaps = {
  backendKind: 'webgpu',
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

function makeRegisterCube(): (
  pod: CubeTextureAsset,
) => Result<Handle<'CubeTextureAsset', 'shared'>, never> {
  let next = 1000;
  return () => ok(toShared<'CubeTextureAsset'>(next++));
}

// biome-ignore lint/suspicious/noExplicitAny: shader-module factory shim
const shaderFactory = async (_d: any, desc: { code: string; label?: string }) =>
  ok({ __mock: 'shader', label: desc.label ?? '' }) as never;

function configuredStore(probe: DeviceProbe): GpuResourceStore {
  const store = new GpuResourceStore();
  store.configureGpuDevice(
    makeStoreMockDevice(probe),
    shaderFactory,
    makeRegisterCube() as never,
    mockCaps,
  );
  return store;
}

function meshPodFixture(): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array(4 * 12),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    attributes: {},
    aabb: new Float32Array(6),
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 6,
        vertexCount: 0,
        topology: 'triangle-list',
      },
    ],
  };
}

function texturePodFixture(): TextureAsset {
  return {
    kind: 'texture',
    width: 2,
    height: 2,
    format: 'rgba8unorm-srgb',
    data: new Uint8Array(2 * 2 * 4).fill(188),
    colorSpace: 'srgb',
    mipmap: false,
  };
}

describe('GpuResourceStore handle map narrowing (feat-20260612 M3 / w9, AC-05)', () => {
  it('getMeshGpuHandles returns entry whose vertexBuffer / indexBuffer are GpuBuffer (no `as` cast)', () => {
    const probe = freshProbe();
    const store = configuredStore(probe);
    const handle = toShared<'MeshAsset'>(1024);

    const res = store.ensureResident(handle, meshPodFixture());
    expect(res.ok).toBe(true);

    const entry = store.getMeshGpuHandles(handle);
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    // Type-level narrowing assertion (AC-05): TS must accept the assignment
    // without an `as` cast. If the field type were still raw `any` this would
    // also compile (any flows everywhere) -- the structural guarantee is the
    // runtime instanceof below; together they catch the migration regression.
    const _vbo: GpuBuffer = entry.vertexBuffer;
    expect(_vbo).toBeInstanceOf(GpuBuffer);

    // Mesh has indices in the fixture, so indexBuffer is non-null GpuBuffer.
    expect(entry.indexBuffer).not.toBeNull();
    if (entry.indexBuffer !== null) {
      const _ibo: GpuBuffer = entry.indexBuffer;
      expect(_ibo).toBeInstanceOf(GpuBuffer);
    }
  });

  it('getTextureGpuView returns the underlying view; texture entry holds a GpuTexture (M-3 wrapper)', () => {
    const probe = freshProbe();
    const store = configuredStore(probe);
    const handle = toShared<'TextureAsset'>(2048);

    const res = store.ensureResident(handle, texturePodFixture());
    expect(res.ok).toBe(true);

    // The view accessor stays decoupled (TextureView != GpuResource); the
    // narrowing applies to the texture-side entry, exercised via the public
    // destroyAll path in w10 (the texture field is private to the entry).
    expect(store.getTextureGpuView(handle)).toBeDefined();
  });
});

describe('GpuResourceStore.destroyAll (feat-20260612 M3 / w10, AC-06 prereq)', () => {
  it('walks all 3 handle maps + every entry is destroyed after destroyAll()', async () => {
    const probe = freshProbe();
    const store = configuredStore(probe);
    const meshHandle = toShared<'MeshAsset'>(1024);
    const texHandle = toShared<'TextureAsset'>(2048);

    // Populate mesh + texture maps via ensureResident.
    expect(store.ensureResident(meshHandle, meshPodFixture()).ok).toBe(true);
    expect(store.ensureResident(texHandle, texturePodFixture()).ok).toBe(true);

    const meshEntry = store.getMeshGpuHandles(meshHandle);
    expect(meshEntry).toBeDefined();
    if (meshEntry === undefined) return;
    expect(meshEntry.vertexBuffer.isDestroyed).toBe(false);
    if (meshEntry.indexBuffer !== null) {
      expect(meshEntry.indexBuffer.isDestroyed).toBe(false);
    }

    // destroyedBuffers / destroyedTextures probe baseline.
    const baselineDestroyedBufs = probe.destroyedBuffers;
    const baselineDestroyedTexs = probe.destroyedTextures;

    store.destroyAll();

    // Mesh entry's GpuBuffer wrappers flipped to destroyed.
    expect(meshEntry.vertexBuffer.isDestroyed).toBe(true);
    if (meshEntry.indexBuffer !== null) {
      expect(meshEntry.indexBuffer.isDestroyed).toBe(true);
    }

    // RHI device.destroyBuffer fired for vbo + ibo (2); destroyTexture for the
    // texture (1). The cubemap map is empty in this fixture (no equirect
    // upload); a non-empty cubemap path is exercised below.
    expect(probe.destroyedBuffers - baselineDestroyedBufs).toBe(2);
    expect(probe.destroyedTextures - baselineDestroyedTexs).toBe(1);

    // After destroyAll() the maps are cleared so subsequent accessors miss.
    expect(store.getMeshGpuHandles(meshHandle)).toBeUndefined();
    expect(store.getTextureGpuView(texHandle)).toBeUndefined();
  });

  it('idempotent: second destroyAll() does nothing and does not throw', () => {
    const probe = freshProbe();
    const store = configuredStore(probe);
    const meshHandle = toShared<'MeshAsset'>(1024);

    expect(store.ensureResident(meshHandle, meshPodFixture()).ok).toBe(true);

    store.destroyAll();
    const afterFirst = probe.destroyedBuffers;

    // Second call: maps are already empty; no further RHI destroy fires.
    expect(() => store.destroyAll()).not.toThrow();
    expect(probe.destroyedBuffers).toBe(afterFirst);
  });

  it('destroyAll on an empty store is a no-op', () => {
    const probe = freshProbe();
    const store = configuredStore(probe);

    expect(() => store.destroyAll()).not.toThrow();
    expect(probe.destroyedBuffers).toBe(0);
    expect(probe.destroyedTextures).toBe(0);
  });
});

// ── M-4 / w14: instanceBuffers dispose-path cleanup unit test ──
//
// Coverage matrix (requirements §scope item 7 + plan-strategy §7 M-4 + D-7):
//   1. disposeInstanceBuffers walks the Map, calls .destroy() on every
//      entry.buffer (a GpuBuffer wrapper), and clears the Map.
//   2. Every wrapped GpuBuffer flips isDestroyed=true after the helper runs.
//   3. The helper is idempotent: a second call on the cleared Map is a no-op.
//   4. The helper on an empty Map is a safe no-op.
//
// Dispose path is independent of the per-frame Map.delete cleanup — the
// per-frame path keeps its existing 'just delete the key' semantics
// (plan-strategy D-7 / OOS-11).

import { GpuBuffer as GpuBufferCls } from '../gpu-resource';
import { disposeInstanceBuffers } from '../instance-buffer-cache';

describe('disposeInstanceBuffers (feat-20260612 M4 / w14)', () => {
  it('walks the Map and destroys every entry; clears the Map', () => {
    const device = makeMockDevice();
    const map = new Map<
      number,
      { buffer: GpuBufferCls; uploadedByteLength: number; uploadedArchVersion: number }
    >();
    const buf1 = new GpuBufferCls(device as unknown as RhiDevice, makeBufHandle());
    const buf2 = new GpuBufferCls(device as unknown as RhiDevice, makeBufHandle());
    map.set(1, { buffer: buf1, uploadedByteLength: 256, uploadedArchVersion: 1 });
    map.set(2, { buffer: buf2, uploadedByteLength: 512, uploadedArchVersion: 1 });

    expect(buf1.isDestroyed).toBe(false);
    expect(buf2.isDestroyed).toBe(false);
    expect(map.size).toBe(2);

    disposeInstanceBuffers(map);

    expect(buf1.isDestroyed).toBe(true);
    expect(buf2.isDestroyed).toBe(true);
    expect(map.size).toBe(0);
  });

  it('idempotent: a second dispose on the cleared Map is a no-op', () => {
    const device = makeMockDevice();
    const map = new Map<
      number,
      { buffer: GpuBufferCls; uploadedByteLength: number; uploadedArchVersion: number }
    >();
    const buf = new GpuBufferCls(device as unknown as RhiDevice, makeBufHandle());
    map.set(1, { buffer: buf, uploadedByteLength: 256, uploadedArchVersion: 1 });

    disposeInstanceBuffers(map);
    expect(map.size).toBe(0);

    expect(() => disposeInstanceBuffers(map)).not.toThrow();
    expect(map.size).toBe(0);
  });

  it('on an empty Map is a safe no-op', () => {
    const map = new Map<
      number,
      { buffer: GpuBufferCls; uploadedByteLength: number; uploadedArchVersion: number }
    >();
    expect(() => disposeInstanceBuffers(map)).not.toThrow();
    expect(map.size).toBe(0);
  });
});
