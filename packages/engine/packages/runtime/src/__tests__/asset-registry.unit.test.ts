// M6 w31 (round 5 D-15): column-mint + two-tier resolve integration TDD.
//
// D-15 corrected model (human-inputs implement-architecture-correction
// 2026-06-16T12:35:07Z): AssetRegistry has ZERO handle concept. There is no
// shared slot space shared with the World. A `handle` is purely an ECS column
// value -- a numeric indirect reference resolved two-tier purely by slot range:
//   slot <  BUILTIN_BASE -> BuiltinAssetRegistry.resolve(handle)   (process-static)
//   slot >= BUILTIN_BASE -> world.sharedRefs.resolve(handle)       (user-tier RC)
// resolution is entirely on the ECS/render/extract side, never via AssetRegistry.
//
// Column-mint API (Implementer decision): user-tier payloads mint via
// `world.allocSharedRef(tag, payload)` (already on World). AssetRegistry no
// longer produces a column-usable handle; its residual job is GUID->payload
// cataloguing + `loadByGuid`.
//
// These cases are RED before w49 (AssetRegistry still carries `register` /
// by-handle `get`); w49 removes those entries and turns this file green.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { World } from '@forgeax/engine-ecs';
import type { MeshAsset } from '@forgeax/engine-types';
import { BUILTIN_BASE } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { HANDLE_CUBE } from '../asset-registry';
import { BUILTIN_CUBE, BuiltinAssetRegistry } from '../builtin-asset-registry';

const ASSET_REGISTRY_SRC = readFileSync(
  fileURLToPath(new URL('../asset-registry.ts', import.meta.url)),
  'utf8',
);

function mesh(): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array(12 * 3),
    indices: new Uint16Array([0, 1, 2]),
  } as unknown as MeshAsset;
}

describe('D-15 column-mint via world.allocSharedRef (AC-24)', () => {
  it('mints a user-tier slot >= BUILTIN_BASE and resolves to the same payload', () => {
    const world = new World();
    const payload = mesh();
    const handle = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', payload);
    expect(handle).toBeGreaterThanOrEqual(BUILTIN_BASE);
    const res = world.sharedRefs.resolve<'MeshAsset', MeshAsset>(handle);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe(payload);
  });

  it('two distinct mints get distinct user-tier slots', () => {
    const world = new World();
    const a = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', mesh());
    const b = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', mesh());
    expect(a).not.toBe(b);
    expect(a).toBeGreaterThanOrEqual(BUILTIN_BASE);
    expect(b).toBeGreaterThanOrEqual(BUILTIN_BASE);
  });
});

describe('D-15 builtin handle resolves via BuiltinAssetRegistry (AC-24)', () => {
  it('HANDLE_CUBE (slot < BUILTIN_BASE) resolves through BuiltinAssetRegistry, not the World', () => {
    expect(BuiltinAssetRegistry.resolve(HANDLE_CUBE)).toBe(BUILTIN_CUBE);
    // builtin slot does not live in any World's SharedRefStore
    const world = new World();
    const res = world.sharedRefs.resolve(HANDLE_CUBE);
    expect(res.ok).toBe(false);
  });
});

describe('D-15 AssetRegistry has no handle concept (AC-25, static source assertion)', () => {
  it('exposes no anonymous register(asset) -> Handle column-mint entry', () => {
    // The old `register<T extends Asset>(asset): Result<Handle...>` mint moved
    // to the ECS side (world.allocSharedRef). AssetRegistry must not declare it.
    expect(ASSET_REGISTRY_SRC).not.toMatch(/\n {2}register<T extends Asset>\(asset: T\)/);
  });

  it('exposes no by-handle get(handle) resolution entry', () => {
    // Payload resolution is two-tier by slot range on the ECS/render side;
    // AssetRegistry no longer offers a by-handle `.get(handle)` lookup.
    expect(ASSET_REGISTRY_SRC).not.toMatch(/\n {2}get<T extends Asset>\(handle:/);
  });

  it('holds no handle->payload Map (private assets: Map<number, Asset>)', () => {
    expect(ASSET_REGISTRY_SRC).not.toMatch(/private readonly assets: Map<number, Asset>/);
  });

  it('holds no handle->guid reverse map (handleToGuid)', () => {
    expect(ASSET_REGISTRY_SRC).not.toMatch(/handleToGuid/);
  });
});
