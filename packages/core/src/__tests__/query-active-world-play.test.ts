// query follows the ACTIVE world across the ▶/■ play fork (play-world observability)
//
// solo round-5 (play-world-observability): the eval channel's scope① `query` and
// defineOp plan()'s `query` are built by gateway.buildQueryFn(). It USED to bind
// to the frozen edit `doc.world`, so during ▶ Play `query` returned edit-world
// rows — an AI could not read a running mechanic's live component values through
// the documented door (SKILL.md said "watch the viewport, not re-query"). That
// was a Derive violation: activeWorld/mode/childrenOf all follow _playWorld, only
// query lagged. The fix binds buildQueryFn to activeWorld; this test is the gate.
//
// Sibling: children-of-hierarchy-live.test.ts proves childrenOf walks activeWorld;
// this proves the query-snapshot read path does too — same active-world pointer.

import { describe, expect, it, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { Name, Transform } from '@forgeax/engine-runtime';
import type { EntityHandle } from '../scene/scene-types';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';

function spawnAt(world: World, name: string, x: number): EntityHandle {
  const r = world.spawn(
    { component: Name, data: { value: name } } as never,
    { component: Transform, data: { pos: [x, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } } as never,
  );
  if (!r.ok) throw new Error(`spawn failed: ${String(r.error)}`);
  return r.value as EntityHandle;
}

// QuerySnapshotRow types component payloads as `unknown` ([componentName]:unknown);
// narrow the two fields this test reads (same idiom as query-snapshot-children.test.ts).
type Row = { entity: number; Name: { value: string }; Transform: { pos: number[] } };
const rowOf = (r: unknown): Row => r as Row;

describe('query follows activeWorld across the play fork (round-5 play-world observability)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    const session = createEditSession();
    session.world = new World();
    gw = new EditGateway(session);
    // one authored entity in the edit world at x=100 (the "edit witness")
    spawnAt(gw.doc.world as unknown as World, 'EditWitness', 100);
  });

  it('(a) edit mode: query reads the edit world', () => {
    const q = gw.buildQueryFn();
    const res = q({ with: ['Transform', 'Name'] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows.length).toBe(1);
    expect(rowOf(res.rows[0]).Name.value).toBe('EditWitness');
    expect(rowOf(res.rows[0]).Transform.pos[0]).toBe(100);
  });

  it('(b) play mode: query reads the PLAY world, not the frozen edit world (the fix)', () => {
    // a DISTINCT play world with its own witness at x=7
    const playWorld = new World();
    spawnAt(playWorld, 'PlayWitness', 7);
    gw.enterPlay(playWorld);
    expect(gw.mode).toBe('play');

    // buildQueryFn is rebuilt-free (getWorld called per query) — the SAME fn now
    // reads the play world because it follows activeWorld.
    const q = gw.buildQueryFn();
    const res = q({ with: ['Transform', 'Name'] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // FIX: exactly the play witness, no edit witness leaking through.
    expect(res.rows.length).toBe(1);
    expect(rowOf(res.rows[0]).Name.value).toBe('PlayWitness');
    expect(rowOf(res.rows[0]).Transform.pos[0]).toBe(7);
    // regression guard: the frozen edit witness (x=100) must NOT appear.
    expect(res.rows.some((r) => rowOf(r).Transform.pos[0] === 100)).toBe(false);
  });

  it('(c) a query fn built in edit still follows the pointer into play (per-query getWorld)', () => {
    // build the fn BEFORE play — it must still see the play world after enterPlay,
    // proving getWorld is evaluated per call, not captured once.
    const q = gw.buildQueryFn();
    const before = q({ with: ['Name'] });
    expect(before.ok && rowOf(before.rows[0]).Name.value).toBe('EditWitness');

    const playWorld = new World();
    spawnAt(playWorld, 'PlayWitness', 7);
    gw.enterPlay(playWorld);

    const during = q({ with: ['Name'] });
    expect(during.ok && during.rows.length).toBe(1);
    expect(during.ok && rowOf(during.rows[0]).Name.value).toBe('PlayWitness');
  });

  it('(d) exitPlay: query reads the edit world again (no residue)', () => {
    const playWorld = new World();
    spawnAt(playWorld, 'PlayWitness', 7);
    gw.enterPlay(playWorld);
    gw.exitPlay();
    expect(gw.mode).toBe('edit');

    const q = gw.buildQueryFn();
    const res = q({ with: ['Transform', 'Name'] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows.length).toBe(1);
    expect(rowOf(res.rows[0]).Name.value).toBe('EditWitness');
    expect(rowOf(res.rows[0]).Transform.pos[0]).toBe(100);
  });
});
