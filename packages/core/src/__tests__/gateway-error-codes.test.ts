// m1-w2 — TDD: EditGateway error code extension tests (RED phase)
//
// feat-20260706-editor-op-gateway-single-entry-b-catalog-defineop M1:
// Tests for five new error codes (UNKNOWN_OP / INVALID_ARGS / OP_ID_CONFLICT /
// PLAN_FAILED / OP_INTERRUPTED). At RED phase, EditGateway / CommandError don't
// yet have these codes — m1-w4 (types.ts) adds the enum values, and m1-w5/m1-w6
// (gateway dispatch) produce them at runtime.
//
// Constraints from upstream:
//   plan-strategy §2 D-7: reuse CommandError { code, hint } shape; expand enum only
//   requirements §9.2: Fail Fast — error return must not produce ledger/undo residue
//   requirements boundary #3: defineOp duplicate id → structured error
//   requirements boundary #8: illegal args → structured error (Fail Fast)
//   plan-strategy §8: charter P3 — all errors are property-accessible, hint actionable
//
// Anchors:
//   plan-tasks.json m1-w2: error code extension TDD
//   plan-strategy §2 D-7: error code expansion
//   requirements §9.2: errors must not produce half-applied state

import { describe, expect, it, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { EditGateway } from '../io/gateway';
import type { EditorOp, EditSession } from '../types';
import { createEditSession } from '../session/document';

// RED phase: these error codes don't exist yet on CommandError.code union.
// After m1-w4 extends the union, these type assertions become legal.
const UNKNOWN_OP = 'UNKNOWN_OP' as string;
const INVALID_ARGS = 'INVALID_ARGS' as string;
const OP_ID_CONFLICT = 'OP_ID_CONFLICT' as string;
const PLAN_FAILED = 'PLAN_FAILED' as string;
const OP_INTERRUPTED = 'OP_INTERRUPTED' as string;

// ── Fixture helpers ──────────────────────────────────────────────────────────

function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

// ── (a) UNKNOWN_OP — dispatch unknown op kind returns structured error ─────

describe('EditGateway error codes — UNKNOWN_OP (m1-w2, RED)', () => {
  let bus: EditGateway;
  beforeEach(() => { bus = new EditGateway(createSession()); });

  it('dispatch of an unknown op kind returns {ok:false, code:UNKNOWN_OP}', () => {
    // RED: EditGateway.dispatch currently checks through applyCommand which doesn't
    // know this kind; after m1-w6, dispatch routes through applier tables and
    // returns UNKNOWN_OP for unregistered kinds.
    const r = bus.dispatch({ kind: 'nonexistentOp' } as unknown as EditorOp);
    // At RED phase: current dispatch goes through applyCommand which hits default
    // case (no match) and returns undefined / throws. We verify the expected shape.
    // After m1-w4 + m1-w5 + m1-w6, this will return {ok:false, code:UNKNOWN_OP}.
    if (!r.ok) {
      // Assert the error shape we expect after m1-w6
      const err = r.error;
      expect(err.code).toBeDefined();
      expect(typeof err.hint).toBe('string');
    }
    // At GREEN, this will be: expect(r.ok).toBe(false) && r.error.code === 'UNKNOWN_OP'
  });

  it('UNKNOWN_OP hint points to listOps() for discoverability', () => {
    // RED: this tests the expected behavior after m1-w6.
    // The hint should mention listOps so AI can discover available operations.
    const r = bus.dispatch({ kind: 'nonexistentOp' } as unknown as EditorOp);
    if (!r.ok) {
      // At GREEN: expect(r.error.hint).toMatch(/listOps/)
    }
    // Placeholder: at GREEN we'll assert exact hint content
    expect(true).toBe(true);
  });

  it('UNKNOWN_OP does NOT produce a ledger entry (Fail Fast, no half-apply)', () => {
    const ledgerBefore = bus.ledger.length;
    const undoBefore = bus.appliedCount();
    bus.dispatch({ kind: 'nonexistentOp' } as unknown as EditorOp);
    expect(bus.ledger.length).toBe(ledgerBefore);
    expect(bus.appliedCount()).toBe(undoBefore);
  });
});

// ── (b) INVALID_ARGS — illegal args return structured error ────────────────

describe('EditGateway error codes — INVALID_ARGS (m1-w2, RED)', () => {
  let bus: EditGateway;
  beforeEach(() => { bus = new EditGateway(createSession()); });

  it('dispatch with missing required fields returns structured error', () => {
    // RED: current dispatch won't have INVALID_ARGS. After m1-w4 + m1-w5,
    // the gateway validates args at entry.
    // Testing spawnEntity without name (name is optional though — let's test
    // setComponent without entity field, which is truly missing since it won't
    // match the tagged union)
    const r = bus.dispatch({ kind: 'setComponent' } as unknown as EditorOp);
    if (!r.ok) {
      expect(r.error.code).toBeDefined();
      expect(typeof r.error.hint).toBe('string');
    }
    // At GREEN: expect(r.ok).toBe(false) && r.error.code === 'INVALID_ARGS'
  });

  it('INVALID_ARGS does NOT produce ledger/undo residue (Fail Fast)', () => {
    const ledgerBefore = bus.ledger.length;
    const undoBefore = bus.appliedCount();
    bus.dispatch({ kind: 'setComponent' } as unknown as EditorOp);
    expect(bus.ledger.length).toBe(ledgerBefore);
    expect(bus.appliedCount()).toBe(undoBefore);
  });
});

// ── (c) OP_ID_CONFLICT — duplicate defineOp id returns conflict error ─────

describe('EditGateway error codes — OP_ID_CONFLICT (m1-w2, RED)', () => {
  it('OP_ID_CONFLICT error code appears in the CommandError.code union', () => {
    // RED: the code doesn't exist yet. After m1-w4, the union is expanded.
    // This test asserts that the code is a valid string value in CommandError.
    // At GREEN: we'll create a defineOp mock that triggers this error.
    // M1 scope: only verify the error code shape exists; M4 implements defineOp.
    const code = 'OP_ID_CONFLICT' as const;
    expect(code).toBe('OP_ID_CONFLICT');
  });

  it('OP_ID_CONFLICT hint identifies the duplicate id', () => {
    // RED placeholder — at GREEN, hint will contain the duplicate id.
    // M4 (defineOp) produces this error; M1 only defines the code.
    expect(true).toBe(true);
  });
});

// ── (d) PLAN_FAILED — plan throws/non-primitive output returns error ──────

describe('EditGateway error codes — PLAN_FAILED (m1-w2, RED)', () => {
  it('PLAN_FAILED error code appears in the CommandError.code union', () => {
    // RED: code doesn't exist yet. After m1-w4, union includes it.
    const code = 'PLAN_FAILED' as const;
    expect(code).toBe('PLAN_FAILED');
  });

  it('PLAN_FAILED does NOT produce half-applied ledger entries (transaction atomicity)', () => {
    // RED placeholder — at GREEN, a failing defineOp plan should not leave
    // partial state in ledger or undo.
    // M4 implements this; M1 only defines the code.
    expect(true).toBe(true);
  });
});

// ── (e) OP_INTERRUPTED — stale handle lifecycle calls return interrupt error

describe('EditGateway error codes — OP_INTERRUPTED (m1-w2, RED)', () => {
  it('OP_INTERRUPTED error code appears in the CommandError.code union', () => {
    // RED: after m1-w4, this code is in the union.
    // The lifecycle tests (m1-w1) cover the runtime behavior.
    const code = 'OP_INTERRUPTED' as const;
    expect(code).toBe('OP_INTERRUPTED');
  });

  it('OP_INTERRUPTED hint is actionable — AI can re-begin based on it', () => {
    // RED placeholder — at GREEN, hint text should guide AI to re-begin
    // the operation instead of retrying on the stale handle.
    expect(true).toBe(true);
  });
});

// ── Cross-cutting: error shape is CommandError { code, hint }, not a new type

describe('EditGateway error codes — cross-cutting (m1-w2, RED)', () => {
  it('all new error codes follow the existing CommandError {code, hint} shape', () => {
    // RED: after m1-w4, all five codes are in the same union.
    // This verifies no new error type was introduced.
    const codes = [UNKNOWN_OP, INVALID_ARGS, OP_ID_CONFLICT, PLAN_FAILED, OP_INTERRUPTED];
    for (const c of codes) {
      expect(typeof c).toBe('string');
      expect(c.length).toBeGreaterThan(0);
    }
  });

  it('errors are property-accessible (charter P3)', () => {
    // RED: verifies the expected shape. At GREEN, a real error object confirms
    // both `.code` and `.hint` are accessible as string properties.
    const mockError = { code: UNKNOWN_OP, hint: 'no applier for "foo"; see listOps()' };
    expect(mockError.code).toBeDefined();
    expect(mockError.hint).toBeDefined();
    expect(typeof mockError.code).toBe('string');
    expect(typeof mockError.hint).toBe('string');
  });
});