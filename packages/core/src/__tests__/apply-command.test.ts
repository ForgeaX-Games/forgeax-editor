// m1-test-command-red — applyCommand 9 case world-state assertions (GREEN stage)
//
// feat-20260701-editor-world-container-doc-ecs-collapse M1 / AC-01:
// These tests assert that applyCommand operating on session.world produces the
// correct engine component state. GREEN after m1-impl-9cases rewrites
// applyCommand's 9 cases to operate on session.world directly.
//
// Each test case uses a real World (new World()), injects it into an EditSession
// via makeEditSession, dispatches the command, and asserts world state via
// world.get(e, C).
//
// Entity IDs: applyCommand's spawnEntity sets `(cmd as any)._id = engineHandle` on the
// command object itself (side effect). Tests capture the command reference to
// read the engine-assigned handle after dispatch.
//
// Engine components (Name, Transform, ChildOf, MeshFilter) are globally
// registered by defineComponent at engine-runtime import time.
//
// Anchors:
//   plan-tasks.json m1-test-command-red: applyCommand 9 case world assertions
//   requirements AC-01: applyCommand 9 case -> session.world
//   plan-strategy S5.1: TDD red->green
//   research F-WorldAPI: world.get/set/spawn/despawn/addComponent/removeComponent

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import type { EntityHandle } from '../scene/scene-types';
import {
  ChildOf,
  Name,
  Transform,
  MeshFilter,
} from '@forgeax/engine-runtime';
import type { Handle } from '@forgeax/engine-runtime';
import { applyCommand, createEditSession } from '../session/document';
import { EditorHidden } from '../components/EditorHidden';
import { worldEntityHandles } from '../store/entity-state';
import type { EditorOp, EditSession } from '../types';

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Create a fresh EditSession backed by a real World.
 *  M7 / AC-15: createEditSession seeds its own world; tests inject a fresh
 *  World to keep isolation. Legacy ID → handle map lives in entity-state
 *  (read via entHandle), not doc.entities. */
function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

/** Dispatch spawnEntity and extract the engine entity handle.
 *  applyCommand sets (cmd as any)._id = legacy ID; entHandle(session, legacyId) resolves
 *  the real engine handle from the session's internal map. */
function spawnEngineHandle(session: EditSession, name: string, parent?: number): { legacyId: number; engineHandle: EntityHandle } {
  const cmd: EditorOp = { kind: 'spawnEntity', name, ...(parent !== undefined ? { parent } : {}) };
  const r = applyCommand(session, cmd);
  if (!r.ok) throw new Error(`spawnCmd failed: ${r.error.hint}`);
  // Post-t6: EditorOp union is open; _id exists on spawnEntity at runtime but
  // TypeScript cannot narrow through the open tail. Cast for access.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const id = (cmd as any)._id;
  if (id === undefined) throw new Error('spawnCmd did not set ._id');
  // M3 (I1): the applier rewrote cmd._id to the real engine handle — handle IS
  // identity, so legacyId and engineHandle are the same value.
  const engineHandle = id as EntityHandle;
  return { legacyId: id as number, engineHandle };
}

describe('applyCommand world assertions (GREEN)', () => {
  // ── 1. spawnEntity ──────────────────────────────────────────────────────────
  it('spawnEntity: world.spawn creates entity with Name', () => {
    const session = createSession();
    const cmd: EditorOp = { kind: 'spawnEntity', name: 'MyCube' };
    const r = applyCommand(session, cmd);
    expect(r.ok).toBe(true);
    const legacyId = (cmd as any)._id!;
    const eH = (legacyId as EntityHandle);
    const nameResult = session.world.get(eH, Name);
    expect(nameResult.ok).toBe(true);
    if (nameResult.ok) {
      expect(nameResult.value.value).toBe('MyCube');
    }
  });

// ── 2. destroyEntity ────────────────────────────────────────────────────────
  it('destroyEntity: world.despawn removes entity', () => {
    const session = createSession();
    const s = spawnEngineHandle(session, 'ToDelete');
    const r = applyCommand(session, { kind: 'destroyEntity', entity: s.legacyId });
    expect(r.ok).toBe(true);
    const check = session.world.get(s.engineHandle, Name);
    expect(check.ok).toBe(false);
  });

  // ── 3. rename ───────────────────────────────────────────────────────────────
  it('rename: world.set(e, Name, value) updates Name', () => {
    const session = createSession();
    const s = spawnEngineHandle(session, 'OldName');
    const r = applyCommand(session, { kind: 'rename', entity: s.legacyId, name: 'NewName' });
    expect(r.ok).toBe(true);
    const nameResult = session.world.get(s.engineHandle, Name);
    expect(nameResult.ok).toBe(true);
    if (nameResult.ok) expect(nameResult.value.value).toBe('NewName');
  });

  // ── 4. reparent ─────────────────────────────────────────────────────────────
  it('reparent: world.set(e, ChildOf, parent) updates parent', () => {
    const session = createSession();
    const parent = spawnEngineHandle(session, 'Parent');
    const child = spawnEngineHandle(session, 'Child', parent.legacyId);
    const newParent = spawnEngineHandle(session, 'NewParent');
    const r = applyCommand(session, { kind: 'reparent', entity: child.legacyId, parent: newParent.legacyId });
    expect(r.ok).toBe(true);
    const after = session.world.get(child.engineHandle, ChildOf);
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.value.parent).toBe(newParent.engineHandle);
  });

  // ── 5. setComponent ─────────────────────────────────────────────────────────
  it('setComponent: world.set(e, C, patch) partial update', () => {
    const session = createSession();
    const cmd: EditorOp = { kind: 'spawnEntity', name: 'Ent', components: { Transform: { pos: [1, 2, 3] } } };
    applyCommand(session, cmd);
    const eH = ((cmd as any)._id! as EntityHandle);
    const r = applyCommand(session, { kind: 'setComponent', entity: (cmd as any)._id!, component: 'Transform', patch: { pos: [1, 99, 3] } });
    expect(r.ok).toBe(true);
    const t = session.world.get(eH, Transform);
    expect(t.ok).toBe(true);
    if (t.ok) { expect(t.value.pos[1]).toBe(99); expect(t.value.pos[0]).toBe(1); expect(t.value.pos[2]).toBe(3); }
  });

  // ── 6. addComponent ─────────────────────────────────────────────────────────
  it('addComponent: world.addComponent attaches component', () => {
    const session = createSession();
    const s = spawnEngineHandle(session, 'Ent');
    const r = applyCommand(session, { kind: 'addComponent', entity: s.legacyId, component: 'MeshFilter', value: { assetHandle: 1 } });
    expect(r.ok).toBe(true);
    const mf = session.world.get(s.engineHandle, MeshFilter);
    expect(mf.ok).toBe(true);
    if (mf.ok) expect(mf.value.assetHandle).toBe(1 as Handle<'MeshAsset', 'shared'>);
  });

  // ── 7. removeComponent ──────────────────────────────────────────────────────
  it('removeComponent: world.removeComponent detaches', () => {
    const session = createSession();
    const cmd: EditorOp = { kind: 'spawnEntity', name: 'Ent', components: { Transform: { pos: [1, 0, 0] }, MeshFilter: { assetHandle: 1 } } };
    applyCommand(session, cmd);
    const eH = ((cmd as any)._id! as EntityHandle);
    const r = applyCommand(session, { kind: 'removeComponent', entity: (cmd as any)._id!, component: 'MeshFilter' });
    expect(r.ok).toBe(true);
    expect(session.world.get(eH, MeshFilter).ok).toBe(false);
  });

  // ── 8. setHidden ────────────────────────────────────────────────────────────
  it('setHidden: true adds EditorHidden on entity', () => {
    const session = createSession();
    const s = spawnEngineHandle(session, 'Ent');
    const r = applyCommand(session, { kind: 'setHidden', entity: s.legacyId, hidden: true });
    expect(r.ok).toBe(true);
    expect(session.world.get(s.engineHandle, EditorHidden).ok).toBe(true);
  });

  it('setHidden: false removes EditorHidden from entity', () => {
    const session = createSession();
    const s = spawnEngineHandle(session, 'Ent');
    applyCommand(session, { kind: 'setHidden', entity: s.legacyId, hidden: true });
    const r = applyCommand(session, { kind: 'setHidden', entity: s.legacyId, hidden: false });
    expect(r.ok).toBe(true);
    expect(session.world.get(s.engineHandle, EditorHidden).ok).toBe(false);
  });

  // ── 9. transaction ──────────────────────────────────────────────────────────
  it('transaction: sub-commands execute atomically', () => {
    const session = createSession();
    const cmd: EditorOp = { kind: 'spawnEntity', name: 'Temp' };
    applyCommand(session, cmd);
    const eH = ((cmd as any)._id! as EntityHandle);
    const r = applyCommand(session, { kind: 'transaction', label: 'rename twice', commands: [{ kind: 'rename', entity: (cmd as any)._id!, name: 'Renamed' }, { kind: 'rename', entity: (cmd as any)._id!, name: 'Final' }] });
    expect(r.ok).toBe(true);
    const nameResult = session.world.get(eH, Name);
    expect(nameResult.ok).toBe(true);
    if (nameResult.ok) expect(nameResult.value.value).toBe('Final');
  });

  it('spawnEntity with parent: world ChildOf linked', () => {
    const session = createSession();
    const parent = spawnEngineHandle(session, 'Parent');
    const child = spawnEngineHandle(session, 'Child', parent.legacyId);
    const co = session.world.get(child.engineHandle, ChildOf);
    expect(co.ok).toBe(true);
    if (co.ok) expect(co.value.parent).toBe(parent.engineHandle);
  });

  // ── 10. transaction forward-reference (solo round-23) ─────────────────────────
  // The transaction op description promises "forward-references work" and now the
  // spawnEntity/transaction argsSchema document the mechanism: a spawn carries a
  // NEGATIVE `_id`; a later sub-op references that negative value as `parent`. The
  // alias map resolves it to the real handle at apply time. Before this contract was
  // projected, a docs-only caller guessed `parent: 0` (a batch index) and hit
  // INVALID_PARENT — these tests lock the working convention + the anti-pattern.
  it('transaction: negative _id forward-reference parents children under the batch-created root', () => {
    const session = createSession();
    const r = applyCommand(session, {
      kind: 'transaction',
      label: 'stream-in chunk (root + 3 children)',
      commands: [
        { kind: 'spawnEntity', name: 'chunk-root', _id: -1 },
        { kind: 'spawnEntity', name: 'chunk-child-0', parent: -1 },
        { kind: 'spawnEntity', name: 'chunk-child-1', parent: -1 },
        { kind: 'spawnEntity', name: 'chunk-child-2', parent: -1 },
      ],
    } as EditorOp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // created[] carries all four spawned roots; created[0] is the chunk root.
    const created = (r as any).created as EntityHandle[];
    expect(created.length).toBe(4);
    const rootH = created[0]!;
    // Every child's ChildOf resolves to the batch-created root handle.
    for (let i = 1; i < 4; i++) {
      const co = session.world.get(created[i]!, ChildOf);
      expect(co.ok).toBe(true);
      if (co.ok) expect(co.value.parent).toBe(rootH);
    }
    // The root itself is a root (no ChildOf).
    expect(session.world.get(rootH, ChildOf).ok).toBe(false);
  });

  it('transaction: a NON-NEGATIVE parent is a literal handle, not a batch index — a nonexistent one fails INVALID_PARENT and rolls back', () => {
    const session = createSession();
    // The anti-pattern the schema now warns against: a docs-only caller guessing
    // "parent is the batch index of an earlier spawn". It is NOT — `toEntity`
    // (document.ts) treats any ref >= 0 as a concrete engine handle. Index
    // semantics would make a small positive int resolve to a batch member; literal
    // semantics make a nonexistent handle fail. We use a clearly-absent handle so
    // the assertion is environment-independent (unlike `parent: 0`, which in a fresh
    // world coincidentally IS the first-spawned root's handle).
    const r = applyCommand(session, {
      kind: 'transaction',
      label: 'wrong forward-ref via positive literal',
      commands: [
        { kind: 'spawnEntity', name: 'root', _id: -1 },
        { kind: 'spawnEntity', name: 'child', parent: 987654 },
      ],
    } as EditorOp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_PARENT');
    // Atomicity: the root spawn rolled back too — the world has no 'root'.
    const names = worldEntityHandles(session.world)
      .map((h) => session.world.get(h, Name))
      .filter((nr) => nr.ok)
      .map((nr) => (nr as { ok: true; value: { value: string } }).value.value);
    expect(names).not.toContain('root');
  });
});