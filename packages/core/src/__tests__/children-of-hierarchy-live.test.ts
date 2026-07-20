// w28 — AC-09 hierarchy-live: childrenOf walks the ACTIVE world
//
// feat-20260707-editor-world-fork M3 (I1 / AC-09): the hierarchy walk follows the
// gateway's activeWorld pointer. In play mode activeWorld === playWorld, so a
// runtime-spawned entity appears in the hierarchy; back in edit mode activeWorld
// === editWorld, so only authored entities show. This unit test drives the
// childrenOf logic directly against a headless playWorld set via enterPlay,
// distinct from the w26 full-boot integration test.
//
// Constraints from upstream:
//   requirements AC-09: play-mode hierarchy walks playWorld; node key=EntityHandle
//   plan-strategy §7 M3: AC-09 tree-live acceptance anchor
//   plan-strategy D-9: pull-based rebuild off the activeWorld pointer
//
// Anchors:
//   plan-tasks.json w28

import { describe, expect, it, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { Name, Transform, ChildOf } from '@forgeax/engine-runtime';
import type { EntityHandle } from '../scene/scene-types';
import { EditGateway } from '../io/gateway';
import { createEditSession, childrenOf } from '../session/document';

function spawn(world: World, name: string, parent?: EntityHandle): EntityHandle {
  const comps: Array<{ component: unknown; data: Record<string, unknown> }> = [
    { component: Name, data: { value: name } },
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  ];
  if (parent !== undefined) comps.push({ component: ChildOf, data: { parent } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = world.spawn(...(comps as any));
  if (!r.ok) throw new Error(`spawn failed: ${String(r.error)}`);
  return r.value as EntityHandle;
}

describe('w28 — childrenOf walks activeWorld (AC-09 hierarchy-live)', () => {
  let gw: EditGateway;
  let editRoot: EntityHandle;

  beforeEach(() => {
    const session = createEditSession();
    session.world = new World();
    gw = new EditGateway(session);
    // One authored entity in the edit world.
    editRoot = spawn(gw.doc.world as unknown as World, 'EditRoot');
  });

  it('(a) edit mode: childrenOf(null) walks the edit world', () => {
    expect(gw.mode).toBe('edit');
    const roots = childrenOf(gw.activeWorld, null);
    expect(roots).toContain(editRoot);
    expect(roots.length).toBe(1);
  });

  it('(b) play mode: childrenOf(null) walks the playWorld (runtime spawns appear)', () => {
    // Give the edit world a SECOND authored entity so its root count (2) differs
    // from the playWorld's (1) — handles are per-world (both first spawns are
    // handle 0), so identity is compared via the world walk + Name, not raw value.
    spawn(gw.doc.world as unknown as World, 'EditRoot2');
    const playWorld = new World();
    const playRoot = spawn(playWorld, 'PlayRoot');
    const playChild = spawn(playWorld, 'PlayChild', playRoot);
    gw.enterPlay(playWorld);
    expect(gw.mode).toBe('play');

    // childrenOf now walks playWorld — one root (PlayRoot), NOT the two edit roots.
    const roots = childrenOf(gw.activeWorld, null);
    expect(roots.length).toBe(1);
    expect(roots).toContain(playRoot);
    const rootName = gw.activeWorld.get(roots[0]!, Name);
    expect(rootName.ok && rootName.value.value).toBe('PlayRoot');

    // A parent walk returns the live playWorld children (EntityHandle).
    const kids = childrenOf(gw.activeWorld, playRoot);
    expect(kids).toEqual([playChild]);
  });

  it('(c) exitPlay: childrenOf walks the edit world again', () => {
    const playWorld = new World();
    spawn(playWorld, 'PlayRoot');
    gw.enterPlay(playWorld);
    gw.exitPlay();
    expect(gw.mode).toBe('edit');

    // Back on the edit world: only the single authored EditRoot (this test did
    // not add EditRoot2).
    const roots = childrenOf(gw.activeWorld, null);
    expect(roots).toContain(editRoot);
    expect(roots.length).toBe(1);
  });

  it('(d) node key is the EntityHandle (identity, not a legacy id)', () => {
    const playWorld = new World();
    const playRoot = spawn(playWorld, 'PlayRoot');
    gw.enterPlay(playWorld);
    const roots = childrenOf(gw.activeWorld, null);
    // The returned value IS the engine handle we spawned — same identity.
    expect(roots[0]).toBe(playRoot);
  });
});
