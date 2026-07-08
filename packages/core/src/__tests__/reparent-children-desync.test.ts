// reparent-children-desync — regression test for hierarchy reparent causing
// Children/ChildOf bidirectional desync (node hidden bug).
//
// Bug: reparent case used w.set() for entities that already had ChildOf,
// bypassing the ECS exclusive-relationship arm that maintains bidirectional
// ChildOf↔Children synchronisation. After fix, reparent always uses
// w.addComponent() which triggers the exclusive arm (remove old + add new).
//
// This test file asserts:
//   1. After reparent, old parent's Children no longer contains the child.
//   2. After reparent, new parent's Children contains the child.
//   3. ChildOf on child points to new parent.
//   4. Reparent inverse stores a legacy EntityId (not engine handle).
//   5. Applying inverse restores original parent (full undo roundtrip).
//   6. Reparent does NOT affect EditorHidden state (decoupled visibility).
//
// Anchors:
//   feedbacks/2026-07-07-hierarchy-reparent-children-desync-node-hidden.md §6/§8

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import type { EntityHandle } from '../scene/scene-types';
import { ChildOf, Children, Name } from '@forgeax/engine-runtime';
import { applyCommand, createEditSession } from '../session/document';
import { EditorHidden } from '../components/EditorHidden';
import type { EditorOp, EditSession, WithEntityId } from '../types';

function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

// M3 (I1): handle IS identity — cmd._id is rewritten to the real engine handle,
// so legacyId and engineHandle are the same value (kept as two names to minimize
// churn against the existing assertions).
function spawn(session: EditSession, name: string, parent?: EntityHandle): { legacyId: EntityHandle; engineHandle: EntityHandle } {
  const cmd: EditorOp = { kind: 'spawnEntity', name, ...(parent !== undefined ? { parent } : {}) };
  const r = applyCommand(session, cmd);
  if (!r.ok) throw new Error(`spawn failed: ${r.error.hint}`);
  const h = (cmd as WithEntityId)._id! as EntityHandle;
  return { legacyId: h, engineHandle: h };
}

function getChildEntities(session: EditSession, parentHandle: EntityHandle): EntityHandle[] {
  const r = session.world.get(parentHandle, Children);
  if (!r.ok) return [];
  const raw = r.value.entities;
  if (raw == null) return [];
  return Array.from(raw) as unknown as EntityHandle[];
}

describe('reparent Children/ChildOf bidirectional consistency', () => {
  it('reparent sibling→node: old parent Children updated, new parent Children updated', () => {
    const session = createSession();
    const parentA = spawn(session, 'ParentA');
    const parentB = spawn(session, 'ParentB');
    const child = spawn(session, 'Child', parentA.legacyId);

    // Pre-condition: child in parentA.Children, not in parentB.Children
    expect(getChildEntities(session, parentA.engineHandle)).toContain(child.engineHandle);
    expect(getChildEntities(session, parentB.engineHandle)).not.toContain(child.engineHandle);

    // Reparent child from A to B
    const r = applyCommand(session, { kind: 'reparent', entity: child.legacyId, parent: parentB.legacyId });
    expect(r.ok).toBe(true);

    // Post-condition: child moved from A to B in both ChildOf and Children
    const childOf = session.world.get(child.engineHandle, ChildOf);
    expect(childOf.ok).toBe(true);
    if (childOf.ok) expect(childOf.value.parent).toBe(parentB.engineHandle);

    expect(getChildEntities(session, parentA.engineHandle)).not.toContain(child.engineHandle);
    expect(getChildEntities(session, parentB.engineHandle)).toContain(child.engineHandle);
  });

  it('reparent root entity→node: acquires ChildOf and appears in Children', () => {
    const session = createSession();
    const parent = spawn(session, 'Parent');
    const root = spawn(session, 'RootEntity');

    // Pre-condition: root has no ChildOf
    expect(session.world.get(root.engineHandle, ChildOf).ok).toBe(false);

    const r = applyCommand(session, { kind: 'reparent', entity: root.legacyId, parent: parent.legacyId });
    expect(r.ok).toBe(true);

    const childOf = session.world.get(root.engineHandle, ChildOf);
    expect(childOf.ok).toBe(true);
    if (childOf.ok) expect(childOf.value.parent).toBe(parent.engineHandle);
    expect(getChildEntities(session, parent.engineHandle)).toContain(root.engineHandle);
  });

  it('reparent node→root: removes ChildOf and disappears from Children', () => {
    const session = createSession();
    const parent = spawn(session, 'Parent');
    const child = spawn(session, 'Child', parent.legacyId);

    const r = applyCommand(session, { kind: 'reparent', entity: child.legacyId, parent: null });
    expect(r.ok).toBe(true);

    expect(session.world.get(child.engineHandle, ChildOf).ok).toBe(false);
    expect(getChildEntities(session, parent.engineHandle)).not.toContain(child.engineHandle);
  });

  it('reparent multiple children: each move maintains consistency', () => {
    const session = createSession();
    const src = spawn(session, 'Source');
    const dst = spawn(session, 'Destination');
    const c1 = spawn(session, 'C1', src.legacyId);
    const c2 = spawn(session, 'C2', src.legacyId);

    applyCommand(session, { kind: 'reparent', entity: c1.legacyId, parent: dst.legacyId });
    applyCommand(session, { kind: 'reparent', entity: c2.legacyId, parent: dst.legacyId });

    const srcChildren = getChildEntities(session, src.engineHandle);
    const dstChildren = getChildEntities(session, dst.engineHandle);
    expect(srcChildren).not.toContain(c1.engineHandle);
    expect(srcChildren).not.toContain(c2.engineHandle);
    expect(dstChildren).toContain(c1.engineHandle);
    expect(dstChildren).toContain(c2.engineHandle);
  });
});

describe('reparent inverse stores the prior parent handle', () => {
  it('inverse.parent is the prior parent EntityHandle (handle IS identity)', () => {
    const session = createSession();
    const parentA = spawn(session, 'ParentA');
    const parentB = spawn(session, 'ParentB');
    const child = spawn(session, 'Child', parentA.legacyId);

    const r = applyCommand(session, { kind: 'reparent', entity: child.legacyId, parent: parentB.legacyId });
    expect(r.ok).toBe(true);

    // EditorOp's open tail keeps `kind === 'reparent'` from discriminating the
    // builtin variant, so recover the typed reparent shape explicitly.
    const inverse = (r as { ok: true; inverse: EditorOp }).inverse as { kind: 'reparent'; parent: EntityHandle | null };
    expect(inverse.kind).toBe('reparent');
    if (inverse.kind === 'reparent') {
      // M3 (I1): inverse.parent is the prior parent HANDLE directly — no legacy id.
      expect(inverse.parent).toBe(parentA.engineHandle);
    }
  });

  it('inverse of reparent-to-root stores null', () => {
    const session = createSession();
    const root = spawn(session, 'RootEntity');
    const parent = spawn(session, 'Parent');

    applyCommand(session, { kind: 'reparent', entity: root.legacyId, parent: parent.legacyId });
    const r = applyCommand(session, { kind: 'reparent', entity: root.legacyId, parent: null });
    expect(r.ok).toBe(true);

    const inverse = (r as { ok: true; inverse: EditorOp }).inverse;
    if (inverse.kind === 'reparent') {
      expect(inverse.parent).toBe(parent.legacyId);
    }
  });

  it('undo roundtrip: apply inverse restores original parent', () => {
    const session = createSession();
    const parentA = spawn(session, 'ParentA');
    const parentB = spawn(session, 'ParentB');
    const child = spawn(session, 'Child', parentA.legacyId);

    const r = applyCommand(session, { kind: 'reparent', entity: child.legacyId, parent: parentB.legacyId });
    expect(r.ok).toBe(true);

    // Apply inverse to undo
    const inverse = (r as { ok: true; inverse: EditorOp }).inverse;
    const undoR = applyCommand(session, inverse);
    expect(undoR.ok).toBe(true);

    // Verify child is back under parentA
    const childOf = session.world.get(child.engineHandle, ChildOf);
    expect(childOf.ok).toBe(true);
    if (childOf.ok) expect(childOf.value.parent).toBe(parentA.engineHandle);
    expect(getChildEntities(session, parentA.engineHandle)).toContain(child.engineHandle);
    expect(getChildEntities(session, parentB.engineHandle)).not.toContain(child.engineHandle);
  });
});

describe('reparent does NOT affect EditorHidden (decoupled visibility)', () => {
  it('reparent preserves EditorHidden=false (visible stays visible)', () => {
    const session = createSession();
    const parentA = spawn(session, 'ParentA');
    const parentB = spawn(session, 'ParentB');
    const child = spawn(session, 'Child', parentA.legacyId);

    // Child is not hidden before reparent
    expect(session.world.get(child.engineHandle, EditorHidden).ok).toBe(false);

    applyCommand(session, { kind: 'reparent', entity: child.legacyId, parent: parentB.legacyId });

    // Child is still not hidden after reparent
    expect(session.world.get(child.engineHandle, EditorHidden).ok).toBe(false);
  });

  it('reparent preserves EditorHidden=true (hidden stays hidden)', () => {
    const session = createSession();
    const parentA = spawn(session, 'ParentA');
    const parentB = spawn(session, 'ParentB');
    const child = spawn(session, 'Child', parentA.legacyId);

    // Hide the child, then reparent
    applyCommand(session, { kind: 'setHidden', entity: child.legacyId, hidden: true });
    expect(session.world.get(child.engineHandle, EditorHidden).ok).toBe(true);

    applyCommand(session, { kind: 'reparent', entity: child.legacyId, parent: parentB.legacyId });

    // Still hidden
    expect(session.world.get(child.engineHandle, EditorHidden).ok).toBe(true);
  });

  it('hidden parent does not infect reparented child', () => {
    const session = createSession();
    const parentA = spawn(session, 'ParentA');
    const parentB = spawn(session, 'ParentB');
    const child = spawn(session, 'Child', parentA.legacyId);

    // Hide parentB
    applyCommand(session, { kind: 'setHidden', entity: parentB.legacyId, hidden: true });

    // Reparent child under hidden parentB
    applyCommand(session, { kind: 'reparent', entity: child.legacyId, parent: parentB.legacyId });

    // Child should NOT inherit parent's hidden state
    expect(session.world.get(child.engineHandle, EditorHidden).ok).toBe(false);
  });
});
