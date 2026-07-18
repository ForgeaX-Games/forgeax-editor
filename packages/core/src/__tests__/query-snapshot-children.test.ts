// query-snapshot-children — regression test for querySnapshot serializing a
// variable array<entity> field (Children.entities) as a real handle list.
//
// Bug (EXPERIMENT-REPORT round-4 friction #1; round-2 deferred #3): a variable
// `array<T>` field takes two archetype columns (a u32 BufferPool slot-id column +
// a `<field>:count` sidecar). The per-column serialization loop read the base
// column as a scalar slot id and leaked the sidecar as a fake field, so a parent's
// Children query surfaced `{ entities: <slotId>, "entities:count": N }` — the
// member handles were unreachable, forcing a defineOp plan to reverse-scan ChildOf.
// The engine always held the real list (world.get(parent, Children).entities);
// only the editor's query projection was wrong. Fix: re-read variable array<T>
// fields whole via the public world.get (SSOT), mirroring the `string` case, and
// suppress the `:count` sidecar.
//
// Anchors:
//   packages/core/src/io/query-snapshot.ts isVariableArrayField / isArrayCountSidecar
//   engine column.ts §D-3 (variable array<T> double-column + `<field>:count`)

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import type { EditorOp, EditSession } from '../types';
import type { WithEntityId } from '../types';
import { applyCommand, createEditSession } from '../session/document';
import { querySnapshot } from '../io/query-snapshot';

function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

function spawn(session: EditSession, name: string): number {
  const cmd: EditorOp = { kind: 'spawnEntity', name, components: { Transform: { pos: [0, 0, 0] } } };
  const r = applyCommand(session, cmd);
  if (!r.ok) throw new Error(`spawn "${name}" failed: ${r.error.hint}`);
  return (cmd as WithEntityId)._id! as unknown as number;
}

describe('querySnapshot — Children.entities (variable array<entity>)', () => {
  it('serializes the real child handle list, not a slot-id + count leak', () => {
    const session = createSession();
    const parent = spawn(session, 'Group');
    const a = spawn(session, 'A');
    const b = spawn(session, 'B');
    const c = spawn(session, 'C');
    for (const child of [a, b, c]) {
      const r = applyCommand(session, { kind: 'reparent', entity: child, parent } as EditorOp);
      expect(r.ok).toBe(true);
    }

    const res = querySnapshot(session.world, { with: ['Children'] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const parentRow = res.rows.find((row) => row.entity === parent);
    expect(parentRow).toBeDefined();
    const children = parentRow!.Children as { entities: unknown };

    // (1) entities is a real array of the three child handles — enumerable, not a scalar.
    expect(Array.isArray(children.entities)).toBe(true);
    expect(children.entities as number[]).toEqual([a, b, c]);

    // (2) no leaked `:count` sidecar field.
    expect(Object.keys(children)).toEqual(['entities']);
    expect((children as Record<string, unknown>)['entities:count']).toBeUndefined();
  });

  it('serializes an empty list for a childless entity (no members, no count leak)', () => {
    const session = createSession();
    const parent = spawn(session, 'Lonely');
    const child = spawn(session, 'Kid');
    // give parent a Children component by reparenting then unparenting the child
    applyCommand(session, { kind: 'reparent', entity: child, parent } as EditorOp);
    applyCommand(session, { kind: 'reparent', entity: child, parent: null } as EditorOp);

    const res = querySnapshot(session.world, { with: ['Children'] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const parentRow = res.rows.find((row) => row.entity === parent);
    if (parentRow && parentRow.Children) {
      const children = parentRow.Children as { entities: unknown };
      expect(Array.isArray(children.entities)).toBe(true);
      expect(children.entities as number[]).toEqual([]);
      expect((children as Record<string, unknown>)['entities:count']).toBeUndefined();
    }
  });
});
