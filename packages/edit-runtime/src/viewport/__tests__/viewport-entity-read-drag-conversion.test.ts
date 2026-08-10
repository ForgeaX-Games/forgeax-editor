// viewport-entity-read-drag-conversion.test.ts — regression lock for the
// parented-entity gizmo-drag bug (2026-08-07, "选中拖拽方向乱了").
//
// Live repro: entity 2690 (mesh node, parented under prefab-internal node 2691
// which carries a 180° Y rotation + translation but NO Name component). An 80px
// drag on the red X handle wrote the WORLD-space target straight into local
// Transform.pos — local became (9.24, 0.24, -3.86) and the entity teleported
// to world (-2.52, 0.48, 0).
//
// Chain: worldPositionToLocal → entComponent(parent, 'Transform') → isStale
// Name-probe misfired on the unnamed-but-live parent → silent identity
// fallback. The fix moves the conversion's ChildOf/Transform hops to direct
// world.get reads (the component read itself is the liveness check) — the
// shared isStale probe stays Name-keyed because the play-mode cross-world
// guard depends on it (see entity-state-unnamed-entity-liveness.test.ts).
//
// These tests lock three behaviors:
//   (1) unnamed parent WITH Transform (rotated) → inverse(parent.world) × target
//       — the exact numbers from the live repro;
//   (2) organizational parent WITHOUT Transform → identity passthrough
//       (propagateTransforms treats the child as a root: world == local);
//   (3) genuinely despawned parent → identity passthrough (edge cut by
//       projectHierarchy, child resolves as root).

import { describe, it, expect } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { ChildOf, Name, Transform, propagateTransforms } from '@forgeax/engine-scene';
import type { EntityHandle } from '@forgeax/engine-ecs';
import { worldPositionToLocal } from '../viewport-entity-read';

const nearVec = (actual: readonly number[], expected: readonly number[]): void => {
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i++) expect(actual[i]!).toBeCloseTo(expected[i]!, 3);
};

/** The live repro's parent pose: 180° about Y + translation, NO Name. */
const PARENT_POS: [number, number, number] = [6.7249, 0.2412, -3.8612];
const PARENT_QUAT_180Y: [number, number, number, number] = [0, 1, 0, 0];
/** What the axis drag computed as the world-space target. */
const DRAG_TARGET: [number, number, number] = [9.2408, 0.2412, -3.8612];
/** inverse(parent.world) × DRAG_TARGET — the correct local write-back. */
const EXPECTED_LOCAL: [number, number, number] = [-2.5159, 0, 0];

function spawnUnnamedParent(world: World): EntityHandle {
  const r = world.spawn(
    { component: Transform, data: { pos: PARENT_POS, quat: PARENT_QUAT_180Y, scale: [1, 1, 1] } },
  );
  if (!r.ok) throw new Error('spawn failed');
  return r.value;
}

function spawnChild(world: World, parent: EntityHandle): EntityHandle {
  const r = world.spawn(
    { component: Name, data: { value: 'mesh-node' } },
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: ChildOf, data: { parent } },
  );
  if (!r.ok) throw new Error('spawn failed');
  return r.value;
}

describe('worldPositionToLocal — parented drag write-back', () => {
  it('(1) unnamed rotated parent: world target converts through inverse(parent.world)', () => {
    const world = new World();
    const parent = spawnUnnamedParent(world);
    const child = spawnChild(world, parent);
    const p = propagateTransforms(world);
    if (!p.ok) throw new Error('propagateTransforms failed');

    // RED before the isStale fix: returned DRAG_TARGET unchanged (identity).
    const local = worldPositionToLocal(world, child, DRAG_TARGET);
    nearVec(local, EXPECTED_LOCAL);
  });

  it('(2) organizational parent WITHOUT Transform keeps identity passthrough', () => {
    const world = new World();
    const r0 = world.spawn({ component: Name, data: { value: 'org-node' } });
    if (!r0.ok) throw new Error('spawn failed');
    const child = spawnChild(world, r0.value);
    const p = propagateTransforms(world);
    if (!p.ok) throw new Error('propagateTransforms failed');

    // propagateTransforms resolveEntity: parent not in the Transform liveMap →
    // child resolves as a root (world == local), so identity IS the contract.
    const local = worldPositionToLocal(world, child, DRAG_TARGET);
    nearVec(local, DRAG_TARGET);
  });

  it('(3) despawned parent keeps identity passthrough without throwing', () => {
    const world = new World();
    const parent = spawnUnnamedParent(world);
    const child = spawnChild(world, parent);
    // ChildOf is linkedSpawn: despawning the parent cascade-despawns the
    // child. The conversion must still degrade to identity, never throw.
    world.despawn(parent);

    const local = worldPositionToLocal(world, child, DRAG_TARGET);
    nearVec(local, DRAG_TARGET);
  });
});
