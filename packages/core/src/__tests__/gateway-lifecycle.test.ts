// m1-w1 — TDD: EditGateway lifecycle begin/update/commit/cancel + interrupt matrix (GREEN phase)
//
// feat-20260706-editor-op-gateway-single-entry-b-catalog-defineop M1:
// These tests assert the lifecycle methods on EditGateway
// (begin / update / commit / cancel) and the single-active-op-slot interrupt
// behavior. m1-w5 (impl) implemented the methods.
//
// Constraints from upstream:
//   plan-strategy §2 D-2: single active-op slot + implicit cancel + OP_INTERRUPTED
//   plan-strategy §6 OOS-2: trace tree belongs to loop 2, ledger stays flat append-only
//   plan-strategy §6 OOS-8: no benchmarking; semantic correctness only
//   requirements boundary #1: cancel leaves no trace (no undo/ledger residue)
//   requirements boundary #2: interrupt must have deterministic behavior
//   plan-strategy §5.1: TDD red-green-refactor enforced
//
// Anchors:
//   plan-tasks.json m1-w1: lifecycle + interrupt matrix tests
//   plan-strategy §2 D-2: single active-op slot
//   plan-strategy §4 R1: interrupt design, TDD first

import { describe, expect, it, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-runtime';
import type { EntityHandle } from '../scene/scene-types';
import { EditGateway } from '../io/gateway';
import { entHandle } from '../store/entity-state';
import type { EditorOp, EditSession, CommandError } from '../types';
import type { DispatchResult } from '../io/gateway';
import { createEditSession } from '../session/document';

// ── Lifecycle API types (expected after m1-w5 impl) ──────────────────────────
// These define the shape EditGateway will expose after m1-w4 + m1-w5.
// At RED phase the bus object does NOT implement these — calls throw.
// After m1-w5, remove casts and use real method signatures.

interface OpHandle {
  readonly id: string;
}

type BeginResult =
  | { ok: true; handle: OpHandle }
  | { ok: false; error: CommandError };

interface LifecycleAPI {
  begin(cmd: EditorOp, origin?: 'human' | 'ai'): BeginResult;
  update(handle: OpHandle, patch: Partial<EditorOp>): DispatchResult;
  commit(handle: OpHandle): DispatchResult;
  cancel(handle: OpHandle): DispatchResult;
}

function lifecycleOf(bus: EditGateway): LifecycleAPI {
  // RED phase: EditGateway doesn't have these methods yet.
  // After m1-w5, this cast can be removed.
  return bus as unknown as LifecycleAPI;
}

// ── Fixture helpers ──────────────────────────────────────────────────────────

function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

/** Spawn an entity and return its legacy ID. */
function spawnEntity(bus: EditGateway, name: string, posX = 0): number {
  const cmd: EditorOp = {
    kind: 'spawnEntity',
    name,
    components: { Transform: { posX, posY: 0, posZ: 0 } },
  };
  const r = bus.dispatch(cmd);
  if (!r.ok) throw new Error(`spawn failed: ${(r as { error: CommandError }).error.hint}`);
  return cmd._id!;
}

function moveCmd(entity: number, posX: number): EditorOp {
  return { kind: 'setComponent', entity, component: 'Transform', patch: { posX } };
}

function readPosX(bus: EditGateway, entity: number): number {
  const h = entHandle(bus.doc, entity) as EntityHandle;
  const tr = bus.doc.world.get(h, Transform);
  if (!tr.ok) throw new Error('Transform not on entity');
  return (tr.value as unknown as { posX: number }).posX;
}

// ── (a) begin snapshots initial state, returns handle ───────────────────────

describe('EditGateway lifecycle — begin (m1-w1, RED)', () => {
  let bus: EditGateway;
  beforeEach(() => { bus = new EditGateway(createSession()); });

  it('begin returns ok:true and a handle with an id', () => {
    spawnEntity(bus, 'box');
    const api = lifecycleOf(bus);
    const r = api.begin(moveCmd(1, 5));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.handle).toBeDefined();
      expect(typeof r.handle.id).toBe('string');
      expect(r.handle.id.length).toBeGreaterThan(0);
    }
  });

  it('begin snapshots the current state so commit can compute inverse', () => {
    spawnEntity(bus, 'box');
    const api = lifecycleOf(bus);
    const initialPosX = readPosX(bus, 1); // should be 0
    const r = api.begin(moveCmd(1, 5));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('begin failed');
    // After begin, state should NOT have changed yet (snapshot only)
    expect(readPosX(bus, 1)).toBe(initialPosX);
  });

  it('begin on a command that would fail (e.g. invalid entity) returns error', () => {
    const api = lifecycleOf(bus);
    const r = api.begin({ kind: 'setComponent', entity: 999, component: 'Transform', patch: { posX: 5 } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBeDefined();
      expect(r.error.hint).toBeDefined();
    }
  });
});

// ── (b) update writes state directly, no ledger/inverse/snapshot broadcast ──

describe('EditGateway lifecycle — update (m1-w1, RED)', () => {
  let bus: EditGateway;
  beforeEach(() => { bus = new EditGateway(createSession()); });

  it('update writes state directly to the world', () => {
    spawnEntity(bus, 'box');
    const api = lifecycleOf(bus);
    const r = api.begin(moveCmd(1, 0));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('begin failed');
    const u = api.update(r.handle, { patch: { posX: 7 } } as Partial<EditorOp>);
    expect(u.ok).toBe(true);
    expect(readPosX(bus, 1)).toBe(7);
  });

  it('update does NOT append to the ledger', () => {
    spawnEntity(bus, 'box');
    const api = lifecycleOf(bus);
    const r = api.begin(moveCmd(1, 0));
    if (!r.ok) throw new Error('begin failed');
    const ledgerBefore = bus.ledger.length;
    api.update(r.handle, { patch: { posX: 3 } } as Partial<EditorOp>);
    expect(bus.ledger.length).toBe(ledgerBefore);
  });

  it('update does NOT grow the undo stack', () => {
    spawnEntity(bus, 'box');
    const api = lifecycleOf(bus);
    const r = api.begin(moveCmd(1, 0));
    if (!r.ok) throw new Error('begin failed');
    const undoBefore = bus.appliedCount();
    api.update(r.handle, { patch: { posX: 3 } } as Partial<EditorOp>);
    expect(bus.appliedCount()).toBe(undoBefore);
  });

  it('multiple updates accumulate (last write wins)', () => {
    spawnEntity(bus, 'box');
    const api = lifecycleOf(bus);
    const r = api.begin(moveCmd(1, 0));
    if (!r.ok) throw new Error('begin failed');
    api.update(r.handle, { patch: { posX: 1 } } as Partial<EditorOp>);
    api.update(r.handle, { patch: { posX: 2 } } as Partial<EditorOp>);
    api.update(r.handle, { patch: { posX: 42 } } as Partial<EditorOp>);
    expect(readPosX(bus, 1)).toBe(42);
  });
});

// ── (c) commit computes from->to inverse, routes to domain undo/ledger ─────

describe('EditGateway lifecycle — commit (m1-w1, RED)', () => {
  let bus: EditGateway;
  beforeEach(() => { bus = new EditGateway(createSession()); });

  it('commit calculates inverse from begin snapshot to final state', () => {
    spawnEntity(bus, 'box'); // posX = 0
    const api = lifecycleOf(bus);
    const r = api.begin(moveCmd(1, 0));
    if (!r.ok) throw new Error('begin failed');
    api.update(r.handle, { patch: { posX: 5 } } as Partial<EditorOp>);
    // State is now posX=5
    const c = api.commit(r.handle);
    expect(c.ok).toBe(true);
    // After commit: posX=5, one undo entry
    expect(readPosX(bus, 1)).toBe(5);
    expect(bus.appliedCount()).toBeGreaterThan(0);
    // Undo should revert to posX=0 (begin snapshot)
    bus.undo();
    expect(readPosX(bus, 1)).toBe(0);
  });

  it('commit appends exactly one ledger entry for document-domain op', () => {
    spawnEntity(bus, 'box');
    const api = lifecycleOf(bus);
    const r = api.begin(moveCmd(1, 0));
    if (!r.ok) throw new Error('begin failed');
    api.update(r.handle, { patch: { posX: 5 } } as Partial<EditorOp>);
    const ledgerBefore = bus.ledger.length;
    api.commit(r.handle);
    expect(bus.ledger.length).toBe(ledgerBefore + 1);
  });

  it('commit releases the active-op slot (next begin can proceed)', () => {
    spawnEntity(bus, 'box');
    const api = lifecycleOf(bus);
    const r1 = api.begin(moveCmd(1, 0));
    if (!r1.ok) throw new Error('begin1 failed');
    api.update(r1.handle, { patch: { posX: 2 } } as Partial<EditorOp>);
    api.commit(r1.handle);
    // After commit, a new begin should succeed without implicitly cancelling
    const r2 = api.begin(moveCmd(1, 10));
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      api.update(r2.handle, { patch: { posX: 10 } } as Partial<EditorOp>);
      api.commit(r2.handle);
      expect(readPosX(bus, 1)).toBe(10);
    }
  });

  it('commit on already-committed handle returns error', () => {
    spawnEntity(bus, 'box');
    const api = lifecycleOf(bus);
    const r = api.begin(moveCmd(1, 0));
    if (!r.ok) throw new Error('begin failed');
    api.commit(r.handle);
    const c2 = api.commit(r.handle); // double-commit
    expect(c2.ok).toBe(false);
  });

  // verify F1: an AI-initiated lifecycle must record origin='ai' in the ledger —
  // human/AI isomorphism (AC-01). Regression guard against commit() hardcoding 'human'.
  it('commit records the origin passed to begin (ai path) — verify F1', () => {
    spawnEntity(bus, 'box');
    const api = lifecycleOf(bus);
    const r = api.begin(moveCmd(1, 0), 'ai');
    if (!r.ok) throw new Error('begin failed');
    api.update(r.handle, { patch: { posX: 7 } } as Partial<EditorOp>);
    api.commit(r.handle);
    expect(bus.origins[bus.origins.length - 1]).toBe('ai');
  });

  it('commit defaults origin to human when begin omits it — verify F1', () => {
    spawnEntity(bus, 'box');
    const api = lifecycleOf(bus);
    const r = api.begin(moveCmd(1, 0));
    if (!r.ok) throw new Error('begin failed');
    api.commit(r.handle);
    expect(bus.origins[bus.origins.length - 1]).toBe('human');
  });
});

// ── (d) cancel rolls back to pre-begin state, leaves no trace ──────────────

describe('EditGateway lifecycle — cancel (m1-w1, RED)', () => {
  let bus: EditGateway;
  beforeEach(() => { bus = new EditGateway(createSession()); });

  it('cancel reverts state to pre-begin snapshot (boundary #1)', () => {
    spawnEntity(bus, 'box'); // posX = 0
    const api = lifecycleOf(bus);
    const r = api.begin(moveCmd(1, 0));
    if (!r.ok) throw new Error('begin failed');
    api.update(r.handle, { patch: { posX: 8 } } as Partial<EditorOp>);
    expect(readPosX(bus, 1)).toBe(8);
    api.cancel(r.handle);
    // After cancel, posX should be back to 0
    expect(readPosX(bus, 1)).toBe(0);
  });

  it('cancel does NOT produce a ledger entry (boundary #1)', () => {
    spawnEntity(bus, 'box');
    const api = lifecycleOf(bus);
    const r = api.begin(moveCmd(1, 0));
    if (!r.ok) throw new Error('begin failed');
    api.update(r.handle, { patch: { posX: 8 } } as Partial<EditorOp>);
    const ledgerBefore = bus.ledger.length;
    api.cancel(r.handle);
    expect(bus.ledger.length).toBe(ledgerBefore);
  });

  it('cancel does NOT grow the undo stack (boundary #1)', () => {
    spawnEntity(bus, 'box');
    const api = lifecycleOf(bus);
    const r = api.begin(moveCmd(1, 0));
    if (!r.ok) throw new Error('begin failed');
    api.update(r.handle, { patch: { posX: 8 } } as Partial<EditorOp>);
    const undoBefore = bus.appliedCount();
    api.cancel(r.handle);
    expect(bus.appliedCount()).toBe(undoBefore);
  });

  it('cancel releases the active-op slot', () => {
    spawnEntity(bus, 'box');
    const api = lifecycleOf(bus);
    const r1 = api.begin(moveCmd(1, 0));
    if (!r1.ok) throw new Error('begin1 failed');
    api.cancel(r1.handle);
    // New begin should succeed
    const r2 = api.begin(moveCmd(1, 5));
    expect(r2.ok).toBe(true);
  });

  it('cancel after commit returns error', () => {
    spawnEntity(bus, 'box');
    const api = lifecycleOf(bus);
    const r = api.begin(moveCmd(1, 0));
    if (!r.ok) throw new Error('begin failed');
    api.update(r.handle, { patch: { posX: 3 } } as Partial<EditorOp>);
    api.commit(r.handle);
    const c = api.cancel(r.handle);
    expect(c.ok).toBe(false);
  });
});

// ── (e) single active-op slot — second begin implicitly cancels first ──────

describe('EditGateway lifecycle — single active-op slot (m1-w1, RED)', () => {
  let bus: EditGateway;
  beforeEach(() => { bus = new EditGateway(createSession()); });

  it('second begin implicitly cancels the first active op', () => {
    spawnEntity(bus, 'box'); // posX = 0
    const api = lifecycleOf(bus);
    const r1 = api.begin(moveCmd(1, 0));
    if (!r1.ok) throw new Error('begin1 failed');
    api.update(r1.handle, { patch: { posX: 5 } } as Partial<EditorOp>);
    expect(readPosX(bus, 1)).toBe(5);

    // Second begin: should implicitly cancel r1 (revert posX to 0), then begin r2
    const r2 = api.begin(moveCmd(1, 10));
    expect(r2.ok).toBe(true);

    // After implicit cancel of r1, state should be back to pre-r1 (posX=0)
    // readPosX after the second begin confirms implicit cancel reverted r1
    expect(readPosX(bus, 1)).toBe(0);

    // r2's begin snapshot is at posX=0 (the reverted state)
    if (r2.ok) {
      api.update(r2.handle, { patch: { posX: 10 } } as Partial<EditorOp>);
      expect(readPosX(bus, 1)).toBe(10);
      api.commit(r2.handle);
      expect(readPosX(bus, 1)).toBe(10);
    }
  });

  it('implicit cancel does NOT grow ledger or undo for the cancelled op', () => {
    spawnEntity(bus, 'box');
    const api = lifecycleOf(bus);
    const r1 = api.begin(moveCmd(1, 0));
    if (!r1.ok) throw new Error('begin1 failed');
    api.update(r1.handle, { patch: { posX: 5 } } as Partial<EditorOp>);
    const ledgerBefore = bus.ledger.length;
    const undoBefore = bus.appliedCount();

    // Second begin triggers implicit cancel of r1
    const r2 = api.begin(moveCmd(1, 0));
    expect(r2.ok).toBe(true);

    // The cancelled r1 should leave NO trace
    expect(bus.ledger.length).toBe(ledgerBefore);
    expect(bus.appliedCount()).toBe(undoBefore);
  });
});

// ── (f) interrupt — stale handle returns OP_INTERRUPTED (boundary #2) ─────

describe('EditGateway lifecycle — interrupt / OP_INTERRUPTED (m1-w1, RED)', () => {
  let bus: EditGateway;
  beforeEach(() => { bus = new EditGateway(createSession()); });

  it('stale handle update returns {ok:false, code:OP_INTERRUPTED} after implicit cancel', () => {
    spawnEntity(bus, 'box');
    const api = lifecycleOf(bus);
    const r1 = api.begin(moveCmd(1, 0));
    if (!r1.ok) throw new Error('begin1 failed');
    api.update(r1.handle, { patch: { posX: 5 } } as Partial<EditorOp>);

    // Interrupt: second begin cancels r1
    api.begin(moveCmd(1, 10));

    // r1 handle is now stale — update should fail with OP_INTERRUPTED
    const u = api.update(r1.handle, { patch: { posX: 99 } } as Partial<EditorOp>);
    expect(u.ok).toBe(false);
    if (!u.ok) {
      expect(u.error.code).toBe('OP_INTERRUPTED');
      expect(typeof u.error.hint).toBe('string');
      expect(u.error.hint.length).toBeGreaterThan(0);
    }
  });

  it('stale handle commit returns OP_INTERRUPTED (boundary #2)', () => {
    spawnEntity(bus, 'box');
    const api = lifecycleOf(bus);
    const r1 = api.begin(moveCmd(1, 0));
    if (!r1.ok) throw new Error('begin1 failed');
    api.update(r1.handle, { patch: { posX: 5 } } as Partial<EditorOp>);

    // Interrupt
    api.begin(moveCmd(1, 10));

    const c = api.commit(r1.handle);
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.error.code).toBe('OP_INTERRUPTED');
    }
  });

  it('stale handle cancel returns OP_INTERRUPTED (boundary #2)', () => {
    spawnEntity(bus, 'box');
    const api = lifecycleOf(bus);
    const r1 = api.begin(moveCmd(1, 0));
    if (!r1.ok) throw new Error('begin1 failed');
    api.update(r1.handle, { patch: { posX: 5 } } as Partial<EditorOp>);

    // Interrupt
    api.begin(moveCmd(1, 10));

    const c = api.cancel(r1.handle);
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.error.code).toBe('OP_INTERRUPTED');
    }
  });

  it('OP_INTERRUPTED error includes a descriptive hint (charter P3)', () => {
    spawnEntity(bus, 'box');
    const api = lifecycleOf(bus);
    const r1 = api.begin(moveCmd(1, 0));
    if (!r1.ok) throw new Error('begin1 failed');

    // Interrupt
    api.begin(moveCmd(1, 10));

    const u = api.update(r1.handle, { patch: { posX: 99 } } as Partial<EditorOp>);
    if (!u.ok) {
      // Hint should mention "interrupted" or "cancelled" so AI can self-correct
      expect(u.error.hint.toLowerCase()).toMatch(/interrupt|cancel|stale|replaced/);
    }
  });

  it('undo does NOT interrupt; undo is a normal dispatcher action', () => {
    // undo is an interrupt source per D-2, but the interruption is implemented
    // by the undo() method itself checking active-op slot before proceeding.
    // This test verifies that after undo, a stale handle sees OP_INTERRUPTED.
    spawnEntity(bus, 'box');
    const api = lifecycleOf(bus);

    // First, commit a normal dispatch to have something to undo
    bus.dispatch(moveCmd(1, 3));
    expect(readPosX(bus, 1)).toBe(3);

    // Begin a lifecycle op
    const r1 = api.begin(moveCmd(1, 3));
    if (!r1.ok) throw new Error('begin1 failed');
    api.update(r1.handle, { patch: { posX: 7 } } as Partial<EditorOp>);

    // undo should implicitly cancel active op
    bus.undo();
    // After undo: posX should be 0 (undo of the dispatch, cancels lifecycle)
    // The stale handle should fail
    const c = api.commit(r1.handle);
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.error.code).toBe('OP_INTERRUPTED');
    }
  });
});

// ── Composite flow: begin → multiple updates → commit → undo ──────────────

describe('EditGateway lifecycle — composite flow (m1-w1, RED)', () => {
  it('full begin-update-update-commit-undo cycle works', () => {
    const bus = new EditGateway(createSession());
    spawnEntity(bus, 'box'); // posX = 0
    const api = lifecycleOf(bus);

    const r = api.begin(moveCmd(1, 0));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('begin failed');
    const h = r.handle;

    api.update(h, { patch: { posX: 2 } } as Partial<EditorOp>);
    expect(readPosX(bus, 1)).toBe(2);

    api.update(h, { patch: { posX: 4 } } as Partial<EditorOp>);
    expect(readPosX(bus, 1)).toBe(4);

    api.commit(h);
    expect(readPosX(bus, 1)).toBe(4);
    // 1 entry for spawnEntity dispatch + 1 entry for lifecycle commit = 2 total
    expect(bus.appliedCount()).toBe(2);

    // Undo should revert to begin snapshot (posX=0)
    bus.undo();
    expect(readPosX(bus, 1)).toBe(0);
  });

  // m3-w6 regression: commit must record the FINAL accumulated forward command
  // (lastCmd), not the begin-time skeleton — otherwise Redo of a migrated gizmo
  // drag snaps back to the pre-drag pose and the ledger misreports the op.
  it('redo after begin-update-commit re-applies the COMMITTED pose (not begin) [m3-w6]', () => {
    const bus = new EditGateway(createSession());
    spawnEntity(bus, 'box'); // posX = 0
    const api = lifecycleOf(bus);
    const r = api.begin(moveCmd(1, 0));
    if (!r.ok) throw new Error('begin failed');
    api.update(r.handle, { patch: { posX: 5 } } as Partial<EditorOp>);
    api.update(r.handle, { patch: { posX: 42 } } as Partial<EditorOp>);
    api.commit(r.handle);
    expect(readPosX(bus, 1)).toBe(42);
    // Ledger records the final pose, not the begin skeleton (posX 42, not 0).
    const last = bus.ledger[bus.ledger.length - 1] as { patch?: { posX?: number } };
    expect(last.patch?.posX).toBe(42);
    // Undo → pre-begin (0); Redo → committed pose (42), NOT the begin snapshot.
    bus.undo();
    expect(readPosX(bus, 1)).toBe(0);
    bus.redo();
    expect(readPosX(bus, 1)).toBe(42);
  });

  it('begin-cancel leaves world unchanged', () => {
    const bus = new EditGateway(createSession());
    spawnEntity(bus, 'box');
    const api = lifecycleOf(bus);

    const r = api.begin(moveCmd(1, 0));
    if (!r.ok) throw new Error('begin failed');
    api.update(r.handle, { patch: { posX: 99 } } as Partial<EditorOp>);
    expect(readPosX(bus, 1)).toBe(99);

    api.cancel(r.handle);
    expect(readPosX(bus, 1)).toBe(0);
    // spawnEntity dispatch created 1 undo entry; cancel adds none
    expect(bus.appliedCount()).toBe(1);
    // spawnEntity is in the ledger; cancel adds none
    expect(bus.ledger.length).toBe(1);
  });
});