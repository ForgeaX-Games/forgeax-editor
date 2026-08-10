// entity-state-unnamed-entity-liveness.test.ts — contract lock for the legacy
// liveness probe behind entComponent (2026-08-07, revised 2026-08-08).
//
// The probe is deliberately Name-keyed. Name is NOT intrinsic (prefab/GLB-
// internal nodes are live without one), so an unnamed live entity reads as
// stale here — that is a LOAD-BEARING trade-off, not an oversight:
//
//   - In play mode the super handle-pair check cannot run (no worldRef/epoch
//     binding for the play world), leaving this legacy fallback as the ONLY
//     stale guard. A bare handle minted in the edit world can numerically
//     collide with a live, unnamed play-world runtime node (deterministic
//     same-doc allocation + runtime spawns), and no engine read can tell the
//     collision apart from a genuinely live entity. The e2e cross-world guard
//     (vfx-particle-runtime Play->Stop round trip) pins stale-entity-handle
//     for exactly that read — the Name probe is what catches it.
//   - The 2026-08-07 Entity-probe "fix" for the gizmo-drag bug proved the
//     coupling: it turned the play-mode collision into a silent
//     component-absent (CI smoke-play red). The drag bug is instead fixed at
//     the read site — viewport-entity-read's worldPositionToLocal reads
//     ChildOf/Transform directly via world.get, where the component read
//     itself is the liveness check (see viewport-entity-read-drag-conversion
//     .test.ts for the drag-side lock).
//
// These tests pin the restored contract:
//   (a) an unnamed live entity reads as stale-entity-handle via the legacy
//       probe (the cross-world guard's collateral) — unnamed-entity read
//       sites MUST bypass entComponent;
//   (b) a genuinely despawned entity is stale-entity-handle;
//   (c) a NAMED live entity missing the requested component reports
//       component-absent, not stale.

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { ChildOf, Name, Transform } from '@forgeax/engine-scene';
import { entComponent } from '../store/entity-state';
import type { EntityHandle } from '../scene/scene-types';

/** Spawn an organizational node the way prefab instantiation does: Transform
 *  (and hierarchy links) but deliberately NO Name component. */
function spawnUnnamed(world: World, parent?: EntityHandle): EntityHandle {
  const r = world.spawn(
    { component: Transform, data: { pos: [1, 2, 3] } },
    ...(parent !== undefined ? [{ component: ChildOf, data: { parent } }] : []),
  );
  if (!r.ok) throw new Error('spawn failed');
  return r.value;
}

describe('isStale legacy probe — Name-keyed contract (cross-world guard)', () => {
  it('(a) an unnamed live entity reads as stale via entComponent — bypass with world.get', () => {
    const world = new World();
    const parent = spawnUnnamed(world);

    // The gated read reports stale (Name probe) even though the entity is
    // alive — this is the collateral the play-mode cross-world guard relies
    // on. Do NOT "fix" this to Entity again (see header).
    const gated = entComponent(world, parent, 'Transform');
    expect(gated.ok).toBe(false);
    if (!gated.ok) expect(gated.error.code).toBe('stale-entity-handle');

    // The bypass read sites use: the component read itself is the liveness
    // check, and the unnamed live parent's Transform resolves fine.
    const direct = world.get(parent, Transform);
    expect(direct.ok).toBe(true);
  });

  it('(b) a despawned entity is still reported stale-entity-handle', () => {
    const world = new World();
    const r0 = world.spawn({ component: Name, data: { value: 'doomed' } });
    if (!r0.ok) throw new Error('spawn failed');
    const e = r0.value;
    expect(entComponent(world, e, 'Name').ok).toBe(true);

    world.despawn(e);

    const r = entComponent(world, e, 'Name');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('stale-entity-handle');
  });

  it('(c) a named live entity missing the requested component reports component-absent, not stale', () => {
    const world = new World();
    const r0 = world.spawn({ component: Name, data: { value: 'org-node' } });
    if (!r0.ok) throw new Error('spawn failed');
    const org = r0.value;

    const r = entComponent(world, org, 'Transform');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('component-absent');
  });
});
