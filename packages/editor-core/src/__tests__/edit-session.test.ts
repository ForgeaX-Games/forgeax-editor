// w29 — EditSession applyCommand equivalence tests (TDD red stage).
//
// M6 replaces the editor's SceneDocument working model with an EditSession that
// holds an engine SceneAsset POD (`asset`) PLUS the editor-local ID management
// (`nextLocalId` self-incrementing allocator + `order` spawn-order list) that the
// engine SceneAsset POD intentionally does NOT carry (A0 red line: engine never
// learns "edit"; plan-strategy D-6).
//
// These tests pin that EditSession.applyCommand reproduces the SAME observable
// semantics the prior SceneDocument-based applyCommand had:
//   - entity set + ID space (self-increment allocator, _id reuse, rollback)
//   - per-entity component values
//   - order list (spawn order; destroy filters it out)
//   - childrenOf hierarchy derivation
//
// The equivalence is asserted directly against the documented SceneDocument
// behavior (research Finding 4: nextId @ document.ts:29-33 incl. rollback
// nextId--, order @ :44/:54/:157) — the OLD type is being deleted in w38, so we
// cannot import both; instead we encode the prior contract as explicit asserts.
//
// Anchors:
//   plan-tasks.json w29: ID management applyCommand equivalence unit test
//   requirements AC-13: SceneDocument removed → applyCommand behavior equivalent
//   plan-strategy D-6: editor-local ID layer (EditSession), engine SceneAsset pure
//   research Finding 4: applyCommand deep-depends on nextId + order

import { describe, expect, it } from 'bun:test';

import {
  createEditSession,
  applyCommand,
  childrenOf,
  isSelfOrDescendant,
} from '../document';
import type { EditSession } from '../types';

describe('EditSession — fresh session shape', () => {
  it('starts empty with nextLocalId=1, empty order/entities, and a scene asset', () => {
    const s = createEditSession();
    expect(s.nextLocalId).toBe(1);
    expect(s.order).toEqual([]);
    expect(s.entities).toEqual({});
    // The engine SceneAsset projection is present and a pure POD (kind:'scene').
    expect(s.asset.kind).toBe('scene');
    expect(s.asset.entities).toEqual([]);
    // A0 red line: the SceneAsset POD must NOT carry editor-only ID fields.
    expect((s.asset as Record<string, unknown>).nextId).toBeUndefined();
    expect((s.asset as Record<string, unknown>).nextLocalId).toBeUndefined();
    expect((s.asset as Record<string, unknown>).order).toBeUndefined();
  });
});

describe('EditSession — spawnEntity ID allocation (equivalent to SceneDocument nextId)', () => {
  it('allocates self-incrementing ids 1,2,3 and appends them to order', () => {
    const s = createEditSession();
    const r1 = applyCommand(s, { kind: 'spawnEntity', name: 'A' });
    const r2 = applyCommand(s, { kind: 'spawnEntity', name: 'B' });
    const r3 = applyCommand(s, { kind: 'spawnEntity', name: 'C' });
    expect(r1.ok && r2.ok && r3.ok).toBe(true);
    expect(s.order).toEqual([1, 2, 3]);
    expect(s.nextLocalId).toBe(4);
    expect(Object.keys(s.entities).map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(s.entities[1]!.name).toBe('A');
    expect(s.entities[3]!.name).toBe('C');
  });

  it('honors a provided _id so destroy-inverse / undo→redo restore the SAME id', () => {
    const s = createEditSession();
    applyCommand(s, { kind: 'spawnEntity', name: 'keep' }); // id 1
    // Re-spawn with an explicit _id beyond the allocator → allocator advances past it.
    const r = applyCommand(s, { kind: 'spawnEntity', name: 'reuse', _id: 7 });
    expect(r.ok).toBe(true);
    expect(s.entities[7]).toBeDefined();
    expect(s.nextLocalId).toBe(8);
  });
});

describe('EditSession — spawnEntity INVALID_PARENT rollback (equivalent to nextId--)', () => {
  it('rolls back the id reservation when parent does not exist', () => {
    const s = createEditSession();
    applyCommand(s, { kind: 'spawnEntity', name: 'root' }); // id 1
    expect(s.nextLocalId).toBe(2);
    const r = applyCommand(s, { kind: 'spawnEntity', name: 'orphan', parent: 999 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_PARENT');
    // The failed allocation must NOT consume an id (the prior code did nextId--).
    expect(s.nextLocalId).toBe(2);
    expect(s.order).toEqual([1]);
    expect(Object.keys(s.entities)).toEqual(['1']);
  });
});

describe('EditSession — destroyEntity (equivalent to order.filter)', () => {
  it('removes the entity and filters it from order; inverse re-spawns the same id', () => {
    const s = createEditSession();
    applyCommand(s, { kind: 'spawnEntity', name: 'A' }); // 1
    applyCommand(s, { kind: 'spawnEntity', name: 'B' }); // 2
    applyCommand(s, { kind: 'spawnEntity', name: 'C' }); // 3
    const r = applyCommand(s, { kind: 'destroyEntity', entity: 2 });
    expect(r.ok).toBe(true);
    expect(s.order).toEqual([1, 3]);
    expect(s.entities[2]).toBeUndefined();
    // inverse is a spawn that restores the same id 2.
    if (r.ok) {
      expect(r.inverse.kind).toBe('spawnEntity');
      const inv = applyCommand(s, r.inverse);
      expect(inv.ok).toBe(true);
      expect(s.entities[2]).toBeDefined();
      expect(s.entities[2]!.name).toBe('B');
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
      components: { Transform: { x: 0, y: 0, z: 0 } },
    }); // 1
    const r = applyCommand(s, { kind: 'setComponent', entity: 1, component: 'Transform', patch: { x: 5 } });
    expect(r.ok).toBe(true);
    expect((s.entities[1]!.components.Transform as Record<string, unknown>).x).toBe(5);
    expect((s.entities[1]!.components.Transform as Record<string, unknown>).y).toBe(0);
    if (r.ok) {
      applyCommand(s, r.inverse);
      expect((s.entities[1]!.components.Transform as Record<string, unknown>).x).toBe(0);
    }
  });

  it('addComponent then removeComponent are mutual inverses', () => {
    const s = createEditSession();
    applyCommand(s, { kind: 'spawnEntity', name: 'e' }); // 1
    const add = applyCommand(s, { kind: 'addComponent', entity: 1, component: 'Mesh', value: { kind: 'cube' } });
    expect(add.ok).toBe(true);
    expect(s.entities[1]!.components.Mesh).toEqual({ kind: 'cube' });
    const rm = applyCommand(s, { kind: 'removeComponent', entity: 1, component: 'Mesh' });
    expect(rm.ok).toBe(true);
    expect(s.entities[1]!.components.Mesh).toBeUndefined();
  });

  it('addComponent on an existing component → COMPONENT_EXISTS', () => {
    const s = createEditSession();
    applyCommand(s, { kind: 'spawnEntity', name: 'e', components: { Mesh: { kind: 'cube' } } });
    const r = applyCommand(s, { kind: 'addComponent', entity: 1, component: 'Mesh', value: { kind: 'sphere' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('COMPONENT_EXISTS');
  });
});

describe('EditSession — childrenOf / isSelfOrDescendant (order-derived hierarchy)', () => {
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

describe('EditSession — transaction rollback (equivalent to SceneDocument transaction)', () => {
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
    expect(s.order).toEqual([1]);
    expect(s.entities[2]).toBeUndefined();
    // Equivalence note: the original SceneDocument transaction rollback replays
    // inverses (a destroyEntity for the first spawn), which does NOT decrement
    // the id allocator — so nextLocalId stays advanced past the consumed id,
    // exactly as the prior nextId allocator did. (Only the direct
    // INVALID_PARENT branch restores the reservation via nextId--.)
    expect(s.nextLocalId).toBe(3);
  });
});

describe('EditSession — asset projection reflects entities/components', () => {
  it('projects spawned entities into the engine SceneAsset POD entities[]', () => {
    const s = createEditSession();
    applyCommand(s, {
      kind: 'spawnEntity',
      name: 'box',
      components: { Transform: { x: 1, y: 2, z: 3 }, Mesh: { kind: 'cube' } },
    });
    // The asset projection carries one entity (the editor authoring entity).
    expect(s.asset.entities.length).toBe(1);
    // localId is assigned (array-index semantics) — pure POD, no editor id field.
    const ent = s.asset.entities[0]! as { localId: number; components: Record<string, unknown> };
    expect(typeof ent.localId).toBe('number');
  });
});
