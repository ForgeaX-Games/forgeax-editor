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
// Entity IDs: applyCommand's spawnEntity sets `cmd._id = engineHandle` on the
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
import { entHandle } from '../store/entity-state';
import { EditorHidden } from '../components/EditorHidden';
import type { EditorCommand, EditSession } from '../types';

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
 *  applyCommand sets cmd._id = legacy ID; entHandle(session, legacyId) resolves
 *  the real engine handle from the session's internal map. */
function spawnEngineHandle(session: EditSession, name: string, parent?: number): { legacyId: number; engineHandle: EntityHandle } {
  const cmd: EditorCommand = { kind: 'spawnEntity', name, ...(parent !== undefined ? { parent } : {}) };
  const r = applyCommand(session, cmd);
  if (!r.ok) throw new Error(`spawnCmd failed: ${r.error.hint}`);
  if (cmd._id === undefined) throw new Error('spawnCmd did not set ._id');
  const legacyId = cmd._id;
  const engineHandle = entHandle(session, legacyId);
  if (engineHandle === undefined) throw new Error(`no engineHandle for legacyId ${legacyId}`);
  // entHandle stores raw numbers; this one is a live engine handle, so brand it
  // as EntityHandle for the world.get(...) calls the assertions run against it.
  return { legacyId, engineHandle: engineHandle as EntityHandle };
}

describe('applyCommand world assertions (GREEN)', () => {
  // ── 1. spawnEntity ──────────────────────────────────────────────────────────
  it('spawnEntity: world.spawn creates entity with Name', () => {
    const session = createSession();
    const cmd: EditorCommand = { kind: 'spawnEntity', name: 'MyCube' };
    const r = applyCommand(session, cmd);
    expect(r.ok).toBe(true);
    const legacyId = cmd._id!;
    const eH = entHandle(session, legacyId)!;
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
    const cmd: EditorCommand = { kind: 'spawnEntity', name: 'Ent', components: { Transform: { posX: 1, posY: 2, posZ: 3 } } };
    applyCommand(session, cmd);
    const eH = entHandle(session, cmd._id!)!;
    const r = applyCommand(session, { kind: 'setComponent', entity: cmd._id!, component: 'Transform', patch: { posY: 99 } });
    expect(r.ok).toBe(true);
    const t = session.world.get(eH, Transform);
    expect(t.ok).toBe(true);
    if (t.ok) { expect(t.value.posY).toBe(99); expect(t.value.posX).toBe(1); expect(t.value.posZ).toBe(3); }
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
    const cmd: EditorCommand = { kind: 'spawnEntity', name: 'Ent', components: { Transform: { posX: 1 }, MeshFilter: { assetHandle: 1 } } };
    applyCommand(session, cmd);
    const eH = entHandle(session, cmd._id!)!;
    const r = applyCommand(session, { kind: 'removeComponent', entity: cmd._id!, component: 'MeshFilter' });
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
    const cmd: EditorCommand = { kind: 'spawnEntity', name: 'Temp' };
    applyCommand(session, cmd);
    const eH = entHandle(session, cmd._id!)!;
    const r = applyCommand(session, { kind: 'transaction', label: 'rename twice', commands: [{ kind: 'rename', entity: cmd._id!, name: 'Renamed' }, { kind: 'rename', entity: cmd._id!, name: 'Final' }] });
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
});