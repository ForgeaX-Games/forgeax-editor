// m1-test-inverse-red — undo/redo inverse command world snapshot (GREEN stage)
//
// feat-20260701-editor-world-container-doc-ecs-collapse M1 / AC-03:
// Three inverse command test scenarios covering world-path undo correctness.
// GREEN after m1-impl-inverse enhances applyCommand's inverse generation.
//
// Scenarios:
//   (a) destroyEntity with 2+ layer ChildOf subtree -> undo restores entities
//   (b) setComponent partial update -> undo restores ONLY changed field
//   (c) transaction with failing 2nd sub-command -> first two rollback
//
// Anchors:
//   plan-tasks.json m1-test-inverse-red: three undo/redo scenarios
//   requirements AC-03: destroy subtree undo + setComponent partial inverse
//   plan-strategy S5.3: inverse command correctness critical test
//   research F-ChildOf-Cascade: despawn(parent) recursively deletes subtree

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import type { EntityHandle } from '../scene/scene-types';
import { ChildOf, Name, Transform } from '@forgeax/engine-runtime';
import { applyCommand, createEditSession } from '../session/document';
import { entHandle } from '../store/entity-state';
import type { EditorCommand, EditSession } from '../types';

// M7 / AC-15: sessions built via createEditSession + injected world; legacy ID
// → engine handle read via entHandle (doc.entities deleted).
function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

function spawnCmd(session: EditSession, name: string, parentLegacyId?: number): { legacyId: number; engineHandle: EntityHandle } {
  const cmd: EditorCommand = { kind: 'spawnEntity', name, ...(parentLegacyId !== undefined ? { parent: parentLegacyId } : {}) };
  const r = applyCommand(session, cmd);
  if (!r.ok) throw new Error(`spawn failed: ${r.error.hint}`);
  const engineHandle = entHandle(session, cmd._id!);
  if (engineHandle === undefined) throw new Error(`no engineHandle for ${cmd._id}`);
  return { legacyId: cmd._id!, engineHandle };
}

describe('inverse commands (GREEN)', () => {
  // ── (a) destroy subtree ─────────────────────────────────────────────────────
  it('(a) destroyEntity with ChildOf subtree: despawn cascades correctly', () => {
    const session = createSession();
    const root = spawnCmd(session, 'Root');
    const child = spawnCmd(session, 'Child', root.legacyId);
    const grandchild = spawnCmd(session, 'Grandchild', child.legacyId);

    expect(session.world.get(root.engineHandle, Name).ok).toBe(true);
    expect(session.world.get(child.engineHandle, Name).ok).toBe(true);
    expect(session.world.get(grandchild.engineHandle, Name).ok).toBe(true);

    const r = applyCommand(session, { kind: 'destroyEntity', entity: root.legacyId });
    expect(r.ok).toBe(true);

    expect(session.world.get(root.engineHandle, Name).ok).toBe(false);
    expect(session.world.get(child.engineHandle, Name).ok).toBe(false);
    expect(session.world.get(grandchild.engineHandle, Name).ok).toBe(false);
  });

  it('(a) destroyEntity undo restores entities (names survive)', () => {
    const session = createSession();
    const root = spawnCmd(session, 'Root');
    const child = spawnCmd(session, 'Child', root.legacyId);
    spawnCmd(session, 'Grandchild', child.legacyId);

    expect(session.world.get(root.engineHandle, Name).ok).toBe(true);

    const r = applyCommand(session, { kind: 'destroyEntity', entity: root.legacyId });
    expect(r.ok).toBe(true);
    expect(session.world.get(root.engineHandle, Name).ok).toBe(false);

    const inverse = (r as { ok: true; inverse: EditorCommand }).inverse;
    const undoR = applyCommand(session, inverse);
    expect(undoR.ok).toBe(true);

    // Verify the inverse spawns entities with the right names
    if (inverse.kind === 'transaction') {
      for (const sub of inverse.commands) {
        if (sub.kind === 'spawnEntity') {
          const spawnedId = sub._id!;
          const handle = entHandle(session, spawnedId);
          expect(handle).toBeDefined();
          if (handle !== undefined) {
            const nc = session.world.get(handle, Name);
            expect(nc.ok).toBe(true);
          }
        }
      }
    }
  });

  // ── (b) setComponent ────────────────────────────────────────────────────────
  it('(b) setComponent: inverse patch contains only changed keys', () => {
    const session = createSession();
    const cmd: EditorCommand = { kind: 'spawnEntity', name: 'Ent', components: { Transform: { posX: 1, posY: 2, posZ: 3 } } };
    applyCommand(session, cmd);
    const eH = entHandle(session, cmd._id!)!;

    const r = applyCommand(session, { kind: 'setComponent', entity: cmd._id!, component: 'Transform', patch: { posY: 99 } });
    expect(r.ok).toBe(true);
    const t = session.world.get(eH, Transform);
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.value.posY).toBe(99);

    const inverse = (r as { ok: true; inverse: EditorCommand }).inverse;
    expect(inverse.kind).toBe('setComponent');
    const invPatch = (inverse as { patch: Record<string, unknown> }).patch;
    expect(Object.keys(invPatch)).toEqual(['posY']);

    const undoR = applyCommand(session, inverse);
    expect(undoR.ok).toBe(true);
    const t2 = session.world.get(eH, Transform);
    expect(t2.ok).toBe(true);
    if (t2.ok) { expect(t2.value.posY).toBe(2); expect(t2.value.posX).toBe(1); expect(t2.value.posZ).toBe(3); }
  });

  // ── (c) transaction ─────────────────────────────────────────────────────────
  it('(c) transaction: second sub-cmd fails, first rollback', () => {
    const session = createSession();
    const s = spawnCmd(session, 'Ent');
    const r = applyCommand(session, { kind: 'transaction', label: 'partial fail', commands: [
      { kind: 'rename', entity: s.legacyId, name: 'Renamed' },
      { kind: 'rename', entity: s.legacyId, name: 'After' },
      { kind: 'rename', entity: 99999, name: 'ShouldFail' },
    ]});
    expect(r.ok).toBe(false);
    const nameResult = session.world.get(s.engineHandle, Name);
    expect(nameResult.ok).toBe(true);
    if (nameResult.ok) expect(nameResult.value.value).toBe('Ent');
  });

  it('(c) transaction: rollback restores pre-transaction state', () => {
    const session = createSession();
    const s = spawnCmd(session, 'Ent');
    const r = applyCommand(session, { kind: 'transaction', label: 'failing', commands: [
      { kind: 'rename', entity: s.legacyId, name: 'X' },
      { kind: 'rename', entity: 99999, name: 'Fails' },
    ]});
    expect(r.ok).toBe(false);
    const nameResult = session.world.get(s.engineHandle, Name);
    expect(nameResult.ok).toBe(true);
    if (nameResult.ok) expect(nameResult.value.value).toBe('Ent');
  });
});