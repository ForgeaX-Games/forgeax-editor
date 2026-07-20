// EditSession applyCommand equivalence tests (M3: handle IS identity rewrite).
//
// feat-20260707-editor-world-fork M3 (I1): the editor-local legacy-id allocator
// + id-to-handle map are deleted. The runtime entity identity IS the engine
// EntityHandle: a spawnEntity applier writes the world and rewrites cmd._id in
// place to the real handle. These tests pin that applyCommand still reproduces
// the observable spawn / destroy / hierarchy / transaction-rollback semantics,
// now asserted through the handle read face (entName/entExists take (world,
// handle)) and childrenOf(world, handle) — not a legacy-id allocator.
//
// Anchors:
//   requirements AC-01: prior document identity model removed → applyCommand equivalent
//   requirements AC-11: childrenOf walks the world (no dedup / no _e2h)
//   plan-strategy R-N3: M3 atomic migration — handle identity

import { describe, expect, it } from 'bun:test';

import {
  createEditSession,
  applyCommand,
  childrenOf,
  isSelfOrDescendant,
} from '../session/document';
import { entExists, entName, worldEntityHandles } from '../store/entity-state';
import type { EntityHandle } from '../scene/scene-types';
import type { EditSession, EditorOp } from '../types';

/** Spawn via applyCommand and return the real engine handle the applier wrote
 *  back onto cmd._id (handle IS identity — no legacy id). */
function spawn(s: EditSession, name: string, parent?: EntityHandle): EntityHandle {
  const cmd: EditorOp = { kind: 'spawnEntity', name, ...(parent !== undefined ? { parent } : {}) };
  const r = applyCommand(s, cmd);
  if (!r.ok) throw new Error(`spawn failed: ${r.error.hint}`);
  const h = (cmd as { _id?: number })._id;
  if (h === undefined) throw new Error('spawn did not set _id');
  return h as EntityHandle;
}

describe('EditSession — fresh session shape', () => {
  it('starts empty with no entities and a live world', () => {
    const s = createEditSession();
    expect(worldEntityHandles(s.world).length).toBe(0);
    expect(s.world).toBeDefined();
  });
});

describe('EditSession — spawnEntity (handle identity)', () => {
  it('spawns entities that exist and carry their name, keyed by handle', () => {
    const s = createEditSession();
    const a = spawn(s, 'A');
    const b = spawn(s, 'B');
    const c = spawn(s, 'C');
    expect(worldEntityHandles(s.world).length).toBe(3);
    expect(entName(s.world, a)).toBe('A');
    expect(entName(s.world, c)).toBe('C');
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
  });
});

describe('EditSession — spawnEntity INVALID_PARENT (no id consumed)', () => {
  it('fails with INVALID_PARENT when parent does not exist; no entity created', () => {
    const s = createEditSession();
    spawn(s, 'root');
    expect(worldEntityHandles(s.world).length).toBe(1);
    const r = applyCommand(s, { kind: 'spawnEntity', name: 'orphan', parent: 999 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_PARENT');
    // The failed spawn must NOT create an entity.
    expect(worldEntityHandles(s.world).length).toBe(1);
  });
});

describe('EditSession — destroyEntity', () => {
  it('removes the entity; inverse re-spawns an entity with the same name', () => {
    const s = createEditSession();
    spawn(s, 'A');
    const b = spawn(s, 'B');
    spawn(s, 'C');
    const r = applyCommand(s, { kind: 'destroyEntity', entity: b });
    expect(r.ok).toBe(true);
    expect(worldEntityHandles(s.world).length).toBe(2);
    expect(entExists(s.world, b)).toBe(false);
    // inverse is a spawn that restores an entity named 'B' (fresh handle —
    // handle identity is not reconstructed across a despawn/respawn cycle).
    if (r.ok) {
      expect(r.inverse.kind).toBe('spawnEntity');
      const inv = applyCommand(s, r.inverse);
      expect(inv.ok).toBe(true);
      const revived = (r.inverse as { _id?: number })._id as EntityHandle;
      expect(entExists(s.world, revived)).toBe(true);
      expect(entName(s.world, revived)).toBe('B');
    }
  });

  it('NO_SUCH_ENTITY for a non-existent target', () => {
    const s = createEditSession();
    const r = applyCommand(s, { kind: 'destroyEntity', entity: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NO_SUCH_ENTITY');
  });
});

describe('EditSession — modifyComponent paths (setComponent / add / remove)', () => {
  it('setComponent merges patch and inverse restores only touched keys', () => {
    const s = createEditSession();
    const e = spawn(s, 'lit');
    const r = applyCommand(s, { kind: 'setComponent', entity: e, component: 'Transform', patch: { pos: [5, 0, 0] } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.inverse.kind).toBe('setComponent');
      const invPatch = (r.inverse as { patch: Record<string, unknown> }).patch;
      expect(Object.keys(invPatch)).toEqual(['pos']);
      // engine array<f32,3> columns yield a Float32Array view; compare by value.
      expect(Array.from(invPatch.pos as ArrayLike<number>)).toEqual([0, 0, 0]);
    }
  });

  it('addComponent then removeComponent are mutual inverses', () => {
    const s = createEditSession();
    const e = spawn(s, 'e');
    const add = applyCommand(s, { kind: 'addComponent', entity: e, component: 'EditorHidden', value: {} });
    expect(add.ok).toBe(true);
    const rm = applyCommand(s, { kind: 'removeComponent', entity: e, component: 'EditorHidden' });
    expect(rm.ok).toBe(true);
    if (add.ok) expect(add.inverse.kind).toBe('removeComponent');
    if (rm.ok) expect(rm.inverse.kind).toBe('addComponent');
  });

  it('addComponent on an existing component → COMPONENT_EXISTS', () => {
    const s = createEditSession();
    const e = spawn(s, 'e');
    applyCommand(s, { kind: 'addComponent', entity: e, component: 'EditorHidden', value: {} });
    const r = applyCommand(s, { kind: 'addComponent', entity: e, component: 'EditorHidden', value: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('COMPONENT_EXISTS');
  });
});

describe('EditSession — childrenOf / isSelfOrDescendant (world-derived hierarchy)', () => {
  function tree(): { s: EditSession; root: EntityHandle; a: EntityHandle; b: EntityHandle; a1: EntityHandle } {
    const s = createEditSession();
    const root = spawn(s, 'root');
    const a = spawn(s, 'a', root);
    const b = spawn(s, 'b', root);
    const a1 = spawn(s, 'a1', a);
    return { s, root, a, b, a1 };
  }

  it('childrenOf returns children, roots via parent===null', () => {
    const { s, root, a, b, a1 } = tree();
    expect(childrenOf(s.world, null)).toEqual([root]);
    expect(childrenOf(s.world, root).sort()).toEqual([a, b].sort());
    expect(childrenOf(s.world, a)).toEqual([a1]);
  });

  it('isSelfOrDescendant detects the subtree (cycle guard)', () => {
    const { s, root, a, b, a1 } = tree();
    expect(isSelfOrDescendant(s.world, root, a1)).toBe(true); // a1 under root
    expect(isSelfOrDescendant(s.world, a, a)).toBe(true); // self
    expect(isSelfOrDescendant(s.world, b, a1)).toBe(false); // a1 not under b
  });
});

describe('EditSession — transaction rollback', () => {
  it('rolls back already-applied sub-commands when a later one fails', () => {
    const s = createEditSession();
    const root = spawn(s, 'root');
    const r = applyCommand(s, {
      kind: 'transaction',
      label: 'spawn two then fail',
      commands: [
        { kind: 'spawnEntity', name: 'ok', parent: root },
        { kind: 'spawnEntity', name: 'bad', parent: 999 }, // INVALID_PARENT
      ],
    });
    expect(r.ok).toBe(false);
    // Atomicity: the first spawn is rolled back too — only 'root' remains.
    expect(worldEntityHandles(s.world).length).toBe(1);
    expect(entName(s.world, root)).toBe('root');
  });
});
