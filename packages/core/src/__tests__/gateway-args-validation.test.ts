// round-1 fixup F-4 — TDD: gateway entry args validation for session/transient ops
//
// feat-20260706-editor-op-gateway-single-entry-b-catalog-defineop F-4:
// The args-schema validator (m4-w6) was imported into io/gateway.ts but never
// called — session/transient dispatch did zero entry validation, so illegal args
// (e.g. setSelection without id) flowed straight into the applier and produced a
// silent bad state ([undefined] in the selection list) instead of a structured
// INVALID_ARGS error. Boundary #8 / D-7 require the gateway to Fail Fast at the
// entry with a structured error. Document ops already validate through
// applyCommand; this test pins the newly-wired session/transient entry check.
//
// Constraints from upstream:
//   requirements boundary #8: illegal args → structured error (Fail Fast)
//   plan-strategy §2 D-7: unknown op / illegal args → gateway entry validation
//   plan-strategy §2 D-1: session/transient ops carry an argsSchema in the catalog
//
// Anchors:
//   implement-review.md F-4
//   io/catalog.ts builtin argsSchema
//   io/args-schema.ts validate()

import { describe, expect, it, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';
import type { EditorOp, EditSession } from '../types';
// Session/transient appliers register as a store-module eval side effect; pull
// them in so the dispatch path routes to a real applier (not UNKNOWN_OP).
import '../store/store';

function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

// ── (a) illegal session args → INVALID_ARGS (the concrete F-4 scenario) ──

describe('F-4 gateway args validation — session ops', () => {
  let gw: EditGateway;
  beforeEach(() => { gw = new EditGateway(createSession()); });

  it('setSelection missing required id → INVALID_ARGS (not silent bad state)', () => {
    const before = gw.ledger.length;
    // The reviewer's concrete failure mode: dispatch without id used to reach the
    // applier and pollute the selection list with [undefined]. Now it is rejected.
    const r = gw.dispatch({ kind: 'setSelection' } as unknown as EditorOp, 'ai');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('INVALID_ARGS');
      expect(typeof r.error.hint).toBe('string');
      expect(r.error.hint.length).toBeGreaterThan(0);
    }
    // Fail Fast: no ledger residue on a rejected op.
    expect(gw.ledger.length).toBe(before);
  });

  it('setGizmoMode with out-of-enum mode → INVALID_ARGS', () => {
    const r = gw.dispatch({ kind: 'setGizmoMode', mode: 'flip' } as unknown as EditorOp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
  });

  it('setSelectionMany with non-array ids → INVALID_ARGS', () => {
    const r = gw.dispatch({ kind: 'setSelectionMany', ids: 5 } as unknown as EditorOp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
  });

  // ── legal shapes still pass (no false positives) ──

  it('setSelection with valid id → ok', () => {
    const r = gw.dispatch({ kind: 'setSelection', id: 1 }, 'ai');
    expect(r.ok).toBe(true);
  });

  it('setSelection with id:null (clear selection) → ok (nullable id)', () => {
    // null is the documented "clear selection" signal — must NOT be rejected.
    const r = gw.dispatch({ kind: 'setSelection', id: null });
    expect(r.ok).toBe(true);
  });

  it('setSceneId with id:null|undefined → ok (nullable/optional)', () => {
    // host-boot dispatches setSceneId({ id: queryParam }) where the param may be
    // null; the schema field is optional + nullable, so this must pass.
    expect(gw.dispatch({ kind: 'setSceneId', id: null }).ok).toBe(true);
    expect(gw.dispatch({ kind: 'setSceneId', id: undefined }).ok).toBe(true);
  });
});

// ── (b) transient ops validated too ──

describe('F-4 gateway args validation — transient ops', () => {
  let gw: EditGateway;
  beforeEach(() => { gw = new EditGateway(createSession()); });

  it('setHoverEntity with id:null (clear hover) → ok', () => {
    const r = gw.dispatch({ kind: 'setHoverEntity', id: null });
    expect(r.ok).toBe(true);
  });

  it('setFieldPreview with only id (optional key/value absent) → ok', () => {
    const r = gw.dispatch({ kind: 'setFieldPreview', id: null });
    expect(r.ok).toBe(true);
  });

  it('setAssetSelection missing required asset → INVALID_ARGS', () => {
    const r = gw.dispatch({ kind: 'setAssetSelection' } as unknown as EditorOp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
  });
});
