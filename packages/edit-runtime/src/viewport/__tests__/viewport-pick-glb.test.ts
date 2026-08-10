// viewport-pick-glb.test.ts — bug-20260806 房屋 GLB viewport 选不中 regression net (CI).
//
// THE BUG: after the M4 world split the engine's mesh-precise pick() is guarded
// off (camera in editorWorld, geometry in sceneWorld), so viewport selection
// falls back to a CPU sweep. The old sweep (a) tested a Transform-scale
// unit-cube heuristic — GLB meshes carry their extents in MeshAsset.aabb with
// identity node scale, so clicks outside pivot±0.5m missed — and (b) enumerated
// only Name-bearing entities, so unnamed GLB mount-internal mesh nodes were not
// even candidates. Net effect: an imported house GLB was unpickable.
//
// These tests lock the fixed behavior of pickMeshFallback
// (viewport-pick-fallback.ts):
//   1. mesh AABB (MeshAsset.aabb × Transform.world) is the hit volume, not the
//      pivot unit-cube — off-pivot clicks on walls/roof hit;
//   2. unnamed mesh nodes ARE candidates (GLB mount members without Name);
//   3. nearest tmin wins; miss → null;
//   4. hidden Visibility on an ancestor excludes the subtree;
//   5. meshes without a populated aabb keep the legacy entityBox heuristic;
//   6. rotation / parent translation come from Transform.world (the old
//      heuristic read local scale only and could not do this at all).

import { describe, expect, it } from 'bun:test';
import { World, type EntityHandle, type Handle } from '@forgeax/engine-ecs';
import { box3, mat4 } from '@forgeax/engine-math';
import { MeshFilter, MeshRenderer, Visibility, VisibilityStateValue } from '@forgeax/engine-render';
import { ChildOf, Name, propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { MeshAsset } from '@forgeax/engine-types';
import { pickMeshFallback } from '../viewport-pick-fallback';
import { aabbToWorldBox, entityBox } from '../viewport-ray';

type V3 = [number, number, number];

/** Minimal MeshAsset whose aabb is derived from 8 corner positions — the same
 *  producer math as the glTF bridge (box3.fromPositions). */
function makeMesh(min: V3, max: V3): MeshAsset {
  const positions = new Float32Array([
    min[0], min[1], min[2], max[0], min[1], min[2], max[0], max[1], min[2], min[0], max[1], min[2],
    min[0], min[1], max[2], max[0], min[1], max[2], max[0], max[1], max[2], min[0], max[1], max[2],
  ]);
  return {
    kind: 'mesh',
    // one stride-12 triangle satisfies the vertices gate; the position
    // attribute drives the AABB (same convention as engine pick tests).
    vertices: new Float32Array(36),
    indices: new Uint16Array([0, 1, 2]),
    submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' }],
    aabb: box3.fromPositions(box3.create(), positions),
    attributes: { position: positions },
  } as MeshAsset;
}

interface MeshEntityOpts {
  name?: string;
  parent?: EntityHandle;
  pos?: V3;
  quat?: [number, number, number, number];
  scale?: V3;
}

function spawnMeshEntity(
  world: World,
  meshHandle: Handle<'MeshAsset', 'shared'>,
  opts: MeshEntityOpts = {},
): EntityHandle {
  const r = world.spawn(
    { component: Transform, data: { pos: opts.pos ?? [0, 0, 0], quat: opts.quat ?? [0, 0, 0, 1], scale: opts.scale ?? [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: meshHandle } },
    { component: MeshRenderer, data: {} },
    ...(opts.name !== undefined ? [{ component: Name, data: { value: opts.name } }] : []),
    ...(opts.parent !== undefined ? [{ component: ChildOf, data: { parent: opts.parent } }] : []),
  );
  if (!r.ok) throw new Error('spawn failed');
  return r.value;
}

/** A 10×6×10 "house" mesh (GLB-style: extents live in vertex data, node scale is 1). */
function makeHouseScene(): { world: World; meshHandle: Handle<'MeshAsset', 'shared'> } {
  const world = new World();
  const meshHandle = world.allocSharedRef('MeshAsset', makeMesh([-5, -3, -5], [5, 3, 5]));
  return { world, meshHandle };
}

describe('bug-20260806 pickMeshFallback — GLB house pickable by real mesh AABB', () => {
  it('off-pivot click (wall region) hits: AABB comes from MeshAsset, not pivot unit-cube', () => {
    const { world, meshHandle } = makeHouseScene();
    // Unnamed GLB mount node, identity transform at the origin.
    const house = spawnMeshEntity(world, meshHandle);
    propagateTransforms(world);

    // Ray enters at (3, 1): inside the real house AABB (x∈[-5,5], y∈[-3,3])
    // but FAR outside the old pivot heuristic box (half=0.5) — this exact ray
    // missed before the fix, so the click cleared the selection.
    expect(pickMeshFallback(world, [3, 1, 20], [0, 0, -1])).toBe(house);
  });

  it('unnamed mesh node IS a pick candidate (Name-keyed enumeration made it unpickable)', () => {
    const { world, meshHandle } = makeHouseScene();
    const house = spawnMeshEntity(world, meshHandle); // no Name — GLB nodes without a name
    propagateTransforms(world);
    expect(pickMeshFallback(world, [0, 0, 20], [0, 0, -1])).toBe(house);
  });

  it('nearest tmin wins when two houses overlap the ray', () => {
    const { world, meshHandle } = makeHouseScene();
    const nearer = spawnMeshEntity(world, meshHandle, { pos: [0, 0, 0] });
    spawnMeshEntity(world, meshHandle, { pos: [0, 0, -12] });
    propagateTransforms(world);
    expect(pickMeshFallback(world, [0, 0, 20], [0, 0, -1])).toBe(nearer);
  });

  it('miss → null (blank click still clears the selection)', () => {
    const { world, meshHandle } = makeHouseScene();
    spawnMeshEntity(world, meshHandle);
    propagateTransforms(world);
    expect(pickMeshFallback(world, [50, 50, 20], [0, 0, -1])).toBeNull();
  });

  it('hidden Visibility on the wrapper ancestor excludes the whole subtree', () => {
    const { world, meshHandle } = makeHouseScene();
    const wrapper = world.spawn(
      { component: Name, data: { value: 'House' } },
      { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    );
    if (!wrapper.ok) throw new Error('spawn failed');
    spawnMeshEntity(world, meshHandle, { parent: wrapper.value });
    propagateTransforms(world);
    expect(pickMeshFallback(world, [0, 0, 20], [0, 0, -1])).not.toBeNull();

    const hide = world.addComponent(wrapper.value, { component: Visibility, data: { state: VisibilityStateValue.hidden } });
    if (!hide.ok) throw new Error('addComponent failed');
    expect(pickMeshFallback(world, [0, 0, 20], [0, 0, -1])).toBeNull();
  });

  it('mesh WITHOUT a populated aabb keeps the legacy Transform-scale heuristic', () => {
    const world = new World();
    const noAabb = { ...makeMesh([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]) } as Record<string, unknown>;
    delete noAabb.aabb;
    const meshHandle = world.allocSharedRef('MeshAsset', noAabb as unknown as MeshAsset);
    // Editor builtin-cube convention: unit mesh × scale 2 → half-extent 1.
    const cube = spawnMeshEntity(world, meshHandle, { name: 'Cube', scale: [2, 2, 2] });
    propagateTransforms(world);
    expect(pickMeshFallback(world, [0, 0.9, 20], [0, 0, -1])).toBe(cube);
    expect(pickMeshFallback(world, [0, 3, 20], [0, 0, -1])).toBeNull();
  });

  it('rotation is honored via Transform.world (90° about Z swaps the long axis)', () => {
    const world = new World();
    // Long thin plank: 10 long on X, 1 thick on Y/Z.
    const plank = world.allocSharedRef('MeshAsset', makeMesh([-5, -0.5, -0.5], [5, 0.5, 0.5]));
    const s = Math.SQRT1_2;
    const e = spawnMeshEntity(world, plank, { quat: [0, 0, s, s] }); // 90° about Z
    propagateTransforms(world);
    // After rotation the plank is long on Y: a ray at y=4 hits…
    expect(pickMeshFallback(world, [0, 4, 20], [0, 0, -1])).toBe(e);
    // …and a ray at x=4 (the LOCAL long axis) now misses.
    expect(pickMeshFallback(world, [4, 0, 20], [0, 0, -1])).toBeNull();
  });

  it('child entity is picked at its propagated WORLD position, not its local one', () => {
    const { world, meshHandle } = makeHouseScene();
    const wrapper = world.spawn(
      { component: Name, data: { value: 'House' } },
      { component: Transform, data: { pos: [10, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    );
    if (!wrapper.ok) throw new Error('spawn failed');
    const child = spawnMeshEntity(world, meshHandle, { parent: wrapper.value });
    propagateTransforms(world);
    // The house stands at x=10: a ray down the local origin misses, a ray at
    // x=10 hits the child.
    expect(pickMeshFallback(world, [0, 0, 20], [0, 0, -1])).toBeNull();
    expect(pickMeshFallback(world, [10, 1, 20], [0, 0, -1])).toBe(child);
  });
});

describe('bug-20260806 aabbToWorldBox — pure math', () => {
  it('identity matrix preserves the box', () => {
    const b = aabbToWorldBox([-5, -3, -5, 5, 3, 5], mat4.identity(mat4.create()));
    expect(b.center[0]).toBeCloseTo(0, 5);
    expect(b.center[1]).toBeCloseTo(0, 5);
    expect(b.half[0]).toBeCloseTo(5, 5);
    expect(b.half[1]).toBeCloseTo(3, 5);
  });

  it('entityBox is unchanged (existing callers: gizmo frame, legacy fallback)', () => {
    const b = entityBox({ x: 1, y: 2, z: 3, scaleX: 4, scaleY: 2, scaleZ: 2 });
    expect(b.center).toEqual([1, 2, 3]);
    expect(b.half).toEqual([2, 1, 1]);
  });
});
