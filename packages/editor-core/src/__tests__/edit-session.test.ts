// EditSession applyCommand equivalence tests (M7 world-SSOT rewrite).
//
// feat-20260701-editor-world-container-doc-ecs-collapse M7 / AC-15:
// The prior document working model (doc.entities/order/nextLocalId + the
// SceneAsset `asset` projection) is deleted — the engine World is the sole
// entity SSOT and EditSession is {world, registry}. These tests pin that
// applyCommand still reproduces the observable ID-management + hierarchy
// semantics, now asserted through the entity-state helpers (legacy ID → engine
// handle map + world.get) instead of doc.entities.
//
// The prior "asset projection" and doc-shape tests are removed: the projection
// layer no longer exists (M4/M5 collapse), and the raw command→world component
// state is already covered exhaustively by apply-command.test.ts. This file
// keeps the ID-allocator + rollback + hierarchy contract, which is the piece
// that lives in the editor-local layer rather than the engine.
//
// Anchors:
//   requirements AC-13: prior document model removed → applyCommand equivalent
//   requirements AC-15: EntityNode/doc.entities zero hits; world is SSOT
//   plan-strategy S2 D-6: editor-local ID layer, engine World pure

import { describe, expect, it } from 'bun:test';

import {
  createEditSession,
  applyCommand,
  childrenOf,
  isSelfOrDescendant,
} from '../document';
import { entExists, entIds, entName, entGetNextId } from '../entity-state';
import type { EditSession } from '../types';

describe('EditSession — fresh session shape', () => {
  it('starts empty with nextLocalId=1, no mapped entities, and a live world', () => {
    const s = createEditSession();
    expect(entGetNextId(s)).toBe(1);
    expect(entIds(s)).toEqual([]);
    // The engine World is the entity container (SSOT); no editor-side entities.
    expect(s.world).toBeDefined();
  });
});

describe('EditSession — spawnEntity ID allocation (equivalent to prior-model nextId)', () => {
  it('allocates self-incrementing ids 1,2,3', () => {
    const s = createEditSession();
    const r1 = applyCommand(s, { kind: 'spawnEntity', name: 'A' });
    const r2 = applyCommand(s, { kind: 'spawnEntity', name: 'B' });
    const r3 = applyCommand(s, { kind: 'spawnEntity', name: 'C' });
    expect(r1.ok && r2.ok && r3.ok).toBe(true);
    expect(entIds(s)).toEqual([1, 2, 3]);
    expect(entGetNextId(s)).toBe(4);
    expect(entName(s, 1)).toBe('A');
    expect(entName(s, 3)).toBe('C');
  });

  it('honors a provided _id so destroy-inverse / undo→redo restore the SAME id', () => {
    const s = createEditSession();
    applyCommand(s, { kind: 'spawnEntity', name: 'keep' }); // id 1
    // Re-spawn with an explicit _id beyond the allocator → allocator advances past it.
    const r = applyCommand(s, { kind: 'spawnEntity', name: 'reuse', _id: 7 });
    expect(r.ok).toBe(true);
    expect(entExists(s, 7)).toBe(true);
    expect(entGetNextId(s)).toBe(8);
  });
});

describe('EditSession — spawnEntity INVALID_PARENT rollback (equivalent to nextId--)', () => {
  it('rolls back the id reservation when parent does not exist', () => {
    const s = createEditSession();
    applyCommand(s, { kind: 'spawnEntity', name: 'root' }); // id 1
    expect(entGetNextId(s)).toBe(2);
    const r = applyCommand(s, { kind: 'spawnEntity', name: 'orphan', parent: 999 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_PARENT');
    // The failed allocation must NOT consume an id (the prior code did nextId--).
    expect(entGetNextId(s)).toBe(2);
    expect(entIds(s)).toEqual([1]);
  });
});

describe('EditSession — destroyEntity (equivalent to order.filter)', () => {
  it('removes the entity; inverse re-spawns the same id + name', () => {
    const s = createEditSession();
    applyCommand(s, { kind: 'spawnEntity', name: 'A' }); // 1
    applyCommand(s, { kind: 'spawnEntity', name: 'B' }); // 2
    applyCommand(s, { kind: 'spawnEntity', name: 'C' }); // 3
    const r = applyCommand(s, { kind: 'destroyEntity', entity: 2 });
    expect(r.ok).toBe(true);
    expect(entIds(s)).toEqual([1, 3]);
    expect(entExists(s, 2)).toBe(false);
    // inverse is a spawn that restores the same id 2.
    if (r.ok) {
      expect(r.inverse.kind).toBe('spawnEntity');
      const inv = applyCommand(s, r.inverse);
      expect(inv.ok).toBe(true);
      expect(entExists(s, 2)).toBe(true);
      expect(entName(s, 2)).toBe('B');
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
    applyCommand(s, {
      kind: 'spawnEntity',
      name: 'lit',
      components: { Transform: { posX: 0, posY: 0, posZ: 0 } },
    }); // 1
    const r = applyCommand(s, { kind: 'setComponent', entity: 1, component: 'Transform', patch: { posX: 5 } });
    expect(r.ok).toBe(true);
    // Inverse restores the pre-edit value (world SSOT — asserted via inverse patch).
    if (r.ok) {
      expect(r.inverse.kind).toBe('setComponent');
      const invPatch = (r.inverse as { patch: Record<string, unknown> }).patch;
      expect(Object.keys(invPatch)).toEqual(['posX']);
      expect(invPatch.posX).toBe(0);
    }
  });

  it('addComponent then removeComponent are mutual inverses', () => {
    const s = createEditSession();
    applyCommand(s, { kind: 'spawnEntity', name: 'e' }); // 1
    // EditorHidden is a real editor-registered engine component (M1); use it as
    // the add/remove target now that the editor-only 'Mesh' authoring component
    // is gone (M7 — component names must resolve against the engine registry).
    const add = applyCommand(s, { kind: 'addComponent', entity: 1, component: 'EditorHidden', value: {} });
    expect(add.ok).toBe(true);
    const rm = applyCommand(s, { kind: 'removeComponent', entity: 1, component: 'EditorHidden' });
    expect(rm.ok).toBe(true);
    // add's inverse is removeComponent, rm's inverse is addComponent — mutual.
    if (add.ok) expect(add.inverse.kind).toBe('removeComponent');
    if (rm.ok) expect(rm.inverse.kind).toBe('addComponent');
  });

  it('addComponent on an existing component → COMPONENT_EXISTS', () => {
    const s = createEditSession();
    applyCommand(s, { kind: 'spawnEntity', name: 'e' });
    applyCommand(s, { kind: 'addComponent', entity: 1, component: 'EditorHidden', value: {} });
    const r = applyCommand(s, { kind: 'addComponent', entity: 1, component: 'EditorHidden', value: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('COMPONENT_EXISTS');
  });
});

describe('EditSession — childrenOf / isSelfOrDescendant (world-derived hierarchy)', () => {
  function tree(): EditSession {
    const s = createEditSession();
    applyCommand(s, { kind: 'spawnEntity', name: 'root' });          // 1
    applyCommand(s, { kind: 'spawnEntity', name: 'a', parent: 1 });  // 2
    applyCommand(s, { kind: 'spawnEntity', name: 'b', parent: 1 });  // 3
    applyCommand(s, { kind: 'spawnEntity', name: 'a1', parent: 2 }); // 4
    return s;
  }

  it('childrenOf returns children in stable order, roots via parent===null', () => {
    const s = tree();
    expect(childrenOf(s, null)).toEqual([1]);
    expect(childrenOf(s, 1)).toEqual([2, 3]);
    expect(childrenOf(s, 2)).toEqual([4]);
  });

  it('isSelfOrDescendant detects the subtree (cycle guard)', () => {
    const s = tree();
    expect(isSelfOrDescendant(s, 1, 4)).toBe(true); // 4 is under 1
    expect(isSelfOrDescendant(s, 2, 2)).toBe(true); // self
    expect(isSelfOrDescendant(s, 3, 4)).toBe(false); // 4 not under 3
  });
});

describe('EditSession — transaction rollback (equivalent to prior-model transaction)', () => {
  it('rolls back already-applied sub-commands when a later one fails', () => {
    const s = createEditSession();
    applyCommand(s, { kind: 'spawnEntity', name: 'root' }); // 1
    const r = applyCommand(s, {
      kind: 'transaction',
      label: 'spawn two then fail',
      commands: [
        { kind: 'spawnEntity', name: 'ok', parent: 1 },
        { kind: 'spawnEntity', name: 'bad', parent: 999 }, // INVALID_PARENT
      ],
    });
    expect(r.ok).toBe(false);
    // Atomicity (entity set): the first spawn must be rolled back too — the
    // transaction replays each applied sub-command's inverse in reverse.
    expect(entIds(s)).toEqual([1]);
    expect(entExists(s, 2)).toBe(false);
    // Equivalence note: rollback replays inverses (a destroyEntity for the first
    // spawn), which does NOT decrement the id allocator — so nextLocalId stays
    // advanced past the consumed id, exactly as the prior nextId allocator did.
    expect(entGetNextId(s)).toBe(3);
  });
});
