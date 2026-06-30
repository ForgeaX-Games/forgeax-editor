// snapshot-restore.test.ts (w13) -- TDD red test for snapshot→restore roundtrip.
//
// Tests the snapshot/restore chain at the bus.doc / EditSession level:
//   1. Deep-copy bus.doc as snapshot (pre▶ state).
//   2. Mutate doc during simulated play (spawn entities, modify fields).
//   3. replaceDoc(snapshot) → assert doc returned to pre▶ state.
//   4. Runtime-spawned entities (not in doc projection) are cleaned up.
//
// TDD: this test is written RED first; w14 (snapshot capture) + w15 (restore)
// turn it GREEN. Anchors:
//   requirements AC-06, AC-07, C-2, C-3, section 9 (play scene temp discards)
//   research Finding 3 (runtime entity escape)
//   plan-strategy D-3 (snapshot = deep copy bus.doc; restore = replaceDoc + cleanup)
//
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  EditorBus,
  createEditSession,
  makeEditSession,
} from '@forgeax/editor-core';
import type { EditSession, EntityId, EntityNode } from '@forgeax/editor-core';

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Deep-copy an EditSession. The snapshot must be independent — mutations
 * to the original must not affect the snapshot, and vice versa.
 *
 * EditSession's `asset` getter is non-enumerable (projectSessionAsset is a
 * getter defined via Object.defineProperty), so a simple spread / JSON round-trip
 * loses it. We reconstruct the session via makeEditSession, which reapplies the
 * getter. EntityNode fields (components / hidden / source) are deep-copied so the
 * clone is a true fork.
 */
function cloneEditSession(session: EditSession): EditSession {
  const entities: Record<EntityId, EntityNode> = {};
  for (const [id, node] of Object.entries(session.entities)) {
    const nid = Number(id);
    entities[nid] = {
      id: node.id,
      name: node.name,
      parent: node.parent,
      components: JSON.parse(JSON.stringify(node.components)),
      ...(node.source ? { source: { ...node.source } } : {}),
      ...(node.hidden !== undefined ? { hidden: node.hidden } : {}),
    };
  }
  return makeEditSession(entities, [...session.order], session.nextLocalId);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('snapshot-restore roundtrip (w13)', () => {
  let bus: EditorBus;

  beforeEach(() => {
    const session = createEditSession();
    bus = new EditorBus(session);
    // Seed a small scene so the pre▶ state is non-trivial.
    bus.dispatch({ kind: 'spawnEntity', name: 'Player', components: { Transform: { x: 0, y: 1, z: 0 }, Mesh: { kind: 'cube' } } });
    bus.dispatch({ kind: 'spawnEntity', name: 'Enemy', components: { Transform: { x: 5, y: 1, z: 3 }, Mesh: { kind: 'sphere' } } });
  });

  it('snapshot deep-copy is independent of the original session', () => {
    const snapshot = cloneEditSession(bus.doc);

    // Mutate original — snapshot must not change.
    const playerId = bus.doc.order?.[0] ?? Object.keys(bus.doc.entities).map(Number)[0]!;
    bus.dispatch({ kind: 'setComponent', entity: playerId, component: 'Transform', patch: { x: 99 } });

    expect(snapshot.entities[playerId]).toBeDefined();
    expect((snapshot.entities[playerId]!.components.Transform as Record<string, number>).x).toBe(0);

    // Snapshot entity count unchanged.
    expect(Object.keys(snapshot.entities).length).toBe(2);
    expect(snapshot.order.length).toBe(2);
  });

  it('snapshot preserves entity names, parent links, and component fields', () => {
    const snapshot = cloneEditSession(bus.doc);
    const ids = Object.keys(snapshot.entities).map(Number);
    const playerNode = Object.values(snapshot.entities).find((n) => n.name === 'Player')!;
    const enemyNode = Object.values(snapshot.entities).find((n) => n.name === 'Enemy')!;

    expect(playerNode).toBeDefined();
    expect(enemyNode).toBeDefined();
    expect((playerNode.components.Transform as Record<string, unknown>)).toEqual({ x: 0, y: 1, z: 0 });
    expect((enemyNode.components.Transform as Record<string, unknown>)).toEqual({ x: 5, y: 1, z: 3 });
  });

  it('replaceDoc restores bus.doc to snapshot state field-level', () => {
    const snapshot = cloneEditSession(bus.doc);
    const playerId = Object.values(bus.doc.entities).find((n) => n.name === 'Player')!.id;

    // Simulate play: mutate an entity field + spawn a runtime entity.
    bus.dispatch({ kind: 'setComponent', entity: playerId, component: 'Transform', patch: { x: 42, y: 10, z: 99 } });
    bus.dispatch({ kind: 'spawnEntity', name: 'Bullet', components: { Transform: { x: 0, y: 0, z: 0 } } });

    // ■ Stop: replaceDoc with snapshot.
    bus.replaceDoc(snapshot);

    // Verify: bus.doc matches snapshot.
    expect(Object.keys(bus.doc.entities).length).toBe(2);
    expect(bus.doc.entities[playerId]).toBeDefined();
    expect((bus.doc.entities[playerId]!.components.Transform as Record<string, number>).x).toBe(0);
    expect((bus.doc.entities[playerId]!.components.Transform as Record<string, number>).y).toBe(1);
    expect((bus.doc.entities[playerId]!.components.Transform as Record<string, number>).z).toBe(0);

    // Bullet (runtime-spawned) is gone — it was never in the snapshot.
    const bulletFound = Object.values(bus.doc.entities).some((n) => n.name === 'Bullet');
    expect(bulletFound).toBe(false);
  });

  it('replaceDoc clears undo/redo and ledger stacks', () => {
    const playerId = Object.values(bus.doc.entities).find((n) => n.name === 'Player')!.id;
    // Accumulate some history.
    bus.dispatch({ kind: 'setComponent', entity: playerId, component: 'Transform', patch: { x: 1 } });
    expect(bus.canUndo()).toBe(true);
    expect(bus.ledger.length).toBeGreaterThan(0);

    const snapshot = cloneEditSession(bus.doc);
    bus.replaceDoc(snapshot);

    expect(bus.canUndo()).toBe(false);
    expect(bus.canRedo()).toBe(false);
    expect(bus.ledger.length).toBe(0);
    expect(bus.origins.length).toBe(0);
  });

  it('replaceDoc fires subscriber with null lastCommand', () => {
    const snapshot = cloneEditSession(bus.doc);
    let receivedDoc: EditSession | null = null;
    let receivedLastCmd: unknown = 'NOT_CALLED';

    bus.subscribe((doc, lastCommand) => {
      receivedDoc = doc;
      receivedLastCmd = lastCommand;
    });

    bus.replaceDoc(snapshot);
    expect(receivedDoc).not.toBeNull();
    expect(receivedLastCmd).toBeNull();
  });

  it('cloneEditSession restores session.asset getter correctly', () => {
    const snapshot = cloneEditSession(bus.doc);
    const asset = snapshot.asset;
    expect(asset).toBeDefined();
    expect(asset.kind).toBe('scene');
    expect(asset.entities.length).toBe(2);
  });

  it('snapshot once: mutating doc after snapshot does not alter snapshot', () => {
    // AC-07: snapshot once at ▶ click; play-scene temp changes must not update it.
    const snapshot = cloneEditSession(bus.doc);
    const playerId = Object.values(bus.doc.entities).find((n) => n.name === 'Player')!.id;

    // Mutate doc (simulate play-scene edit).
    bus.dispatch({ kind: 'setComponent', entity: playerId, component: 'Transform', patch: { x: 999 } });

    // Snapshot unchanged.
    expect((snapshot.entities[playerId]!.components.Transform as Record<string, number>).x).toBe(0);

    // Restore.
    bus.replaceDoc(snapshot);
    expect((bus.doc.entities[playerId]!.components.Transform as Record<string, number>).x).toBe(0);
  });

  it('replaceDoc increments bus.rev for downstream consumers', () => {
    const snapshot = cloneEditSession(bus.doc);
    const revBefore = bus.rev;
    bus.replaceDoc(snapshot);
    expect(bus.rev).toBeGreaterThan(revBefore);
  });
});