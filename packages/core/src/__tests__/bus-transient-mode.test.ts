// w27 — EditGateway.transientMode (requirements AC-11, plan R-D).
//
// play·scene (run=play ∧ display=scene) is UE Simulate: the user can select /
// edit / drag while the game runs, but those edits MUST NOT persist — they don't
// enter the undo stack or the AI ledger, and the ■ Stop snapshot discards them
// (AC-07 double-safety). transientMode is the runtime non-commit half: dispatch
// STILL applyCommand (the world must change for immediate observation) and STILL
// emit (so the engine sync repaints), but it skips undoStack / ledger / origins
// growth. This test pins exactly that: stacks frozen when true, normal when false.
import { describe, it, expect, beforeEach } from 'bun:test';
import { Transform } from '@forgeax/engine-runtime';
import type { EntityHandle } from '../scene/scene-types';
import { EditGateway } from '../io/gateway';
import type { EditorOp } from '../types';

// M3 (I1): the spawn applier writes cmd._id back as the real engine handle.
function seedEntity(bus: EditGateway): EntityHandle {
  // Spawn one entity so setComponent has a target. The spawn itself runs in
  // normal (non-transient) mode so the fixture is deterministic.
  const cmd: EditorOp = { kind: 'spawnEntity', name: 'box', components: { Transform: { posX: 0, posY: 0, posZ: 0 } } };
  bus.dispatch(cmd);
  return (cmd as { _id?: number })._id as EntityHandle;
}

// M7 / AC-15: Transform is native engine POD (posX field), asserted via world.
const move = (entity: EntityHandle, posX: number): EditorOp =>
  ({ kind: 'setComponent', entity, component: 'Transform', patch: { posX } });

describe('EditGateway.transientMode (w27, AC-11)', () => {
  let bus: EditGateway;
  beforeEach(() => { bus = new EditGateway(); });

  it('defaults to false (normal committing mode)', () => {
    expect(bus.transientMode).toBe(false);
  });

  it('transient dispatch does NOT grow undoStack / ledger / origins', () => {
    const e = seedEntity(bus);
    const undoBefore = bus.appliedCount();
    const ledgerBefore = bus.ledger.length;
    const originsBefore = bus.origins.length;

    bus.transientMode = true;
    const r = bus.dispatch(move(e, 5));
    expect(r.ok).toBe(true);

    expect(bus.appliedCount()).toBe(undoBefore); // undo stack frozen — the transient edit added nothing
    expect(bus.ledger.length).toBe(ledgerBefore); // ledger frozen
    expect(bus.origins.length).toBe(originsBefore); // origins frozen
  });

  it('transient dispatch STILL applies the command (world changes for observation)', () => {
    const e = seedEntity(bus);
    bus.transientMode = true;
    bus.dispatch(move(e, 42));
    // applyCommand ran: the world reflects the edit even though it is
    // non-committed. M7 / AC-15: read via world SSOT (doc.entities deleted).
    const t = bus.doc.world.get(e, Transform);
    expect(t.ok).toBe(true);
    if (t.ok) expect((t.value as unknown as Record<string, number>).posX).toBe(42);
  });

  it('transient dispatch STILL emits (rev bumps so engine sync repaints)', () => {
    const e = seedEntity(bus);
    const revBefore = bus.rev;
    let notified = false;
    const unsub = bus.subscribe(() => { notified = true; });
    bus.transientMode = true;
    bus.dispatch(move(e, 7));
    unsub();
    expect(bus.rev).toBeGreaterThan(revBefore); // rev advanced
    expect(notified).toBe(true); // subscribers fired (immediate feedback)
  });

  it('toggling back to false restores normal committing dispatch', () => {
    const e = seedEntity(bus);
    bus.transientMode = true;
    bus.dispatch(move(e, 1)); // not committed
    bus.transientMode = false;
    const undoBefore = bus.appliedCount();
    const ledgerBefore = bus.ledger.length;
    bus.dispatch(move(e, 2)); // committed
    expect(bus.appliedCount()).toBe(undoBefore + 1);
    expect(bus.ledger.length).toBe(ledgerBefore + 1);
    expect(bus.canUndo()).toBe(true);
  });
});
