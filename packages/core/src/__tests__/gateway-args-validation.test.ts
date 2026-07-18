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

// ── (c) BUILTIN DOCUMENT ops validated too (solo round-14) ─────────────────────
//
// Before round-14, builtin document ops SKIPPED door-validation (the dispatch
// check was gated on `source==='defined'`), resting on a false comment that
// "builtin document ops are validated field-by-field inside applyCommand". They
// were NOT: applySetComponent did `Object.keys(cmd.patch)` with no guard, so a
// setComponent missing `patch` (or given addComponent's `value` field by mistake
// — a natural docs-following error, since setComponent uses `patch` and
// addComponent uses `value`) THREW a raw `TypeError: Cannot convert undefined or
// null to object` through the gateway instead of a structured {ok:false,error}.
// These tests are the revert-to-red guard: they FAIL on pre-round-14 main (throw),
// pass now (structured INVALID_ARGS). Fixed at BOTH the door (this suite, top-level
// dispatch) and the applier (document.ts guard, for the sub-op/begin bypass paths).

describe('solo round-14 — builtin document op args validation', () => {
  let gw: EditGateway;
  let ent: number;
  beforeEach(() => {
    gw = new EditGateway(createSession());
    // spawn a real entity carrying a Transform so setComponent has a live target.
    const s = gw.dispatch({
      kind: 'spawnEntity',
      name: 'Target',
      components: { Transform: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    }, 'ai');
    if (!s.ok) throw new Error('spawn failed in test setup');
    ent = (s.result?.created?.[0] as number);
  });

  it('setComponent missing patch → INVALID_ARGS, NOT a thrown TypeError', () => {
    const before = gw.ledger.length;
    // On pre-round-14 main this THREW (Object.keys(undefined)); the gateway must
    // instead return a structured error for all bad input.
    const r = gw.dispatch({ kind: 'setComponent', entity: ent, component: 'Transform' } as unknown as EditorOp, 'ai');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
    expect(gw.ledger.length).toBe(before); // Fail Fast: no ledger residue
  });

  it('setComponent given addComponent\'s `value` field (no patch) → INVALID_ARGS', () => {
    // The exact docs-following mistake the round hit: setComponent uses `patch`,
    // addComponent uses `value`; passing `value` used to crash, now guided.
    const r = gw.dispatch({ kind: 'setComponent', entity: ent, component: 'Transform', value: { pos: [1, 2, 3] } } as unknown as EditorOp, 'ai');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
  });

  it('setComponent with a real patch still round-trips → ok (no false positive)', () => {
    const r = gw.dispatch({ kind: 'setComponent', entity: ent, component: 'Transform', patch: { pos: [4, 5, 6] } }, 'ai');
    expect(r.ok).toBe(true);
  });

  it('spawnEntity{parent:null} still succeeds (nullable regression guard)', () => {
    // reparent-to-root / root-spawn use parent:null; the catalog schema gained
    // nullable:true so the now-enforced door-validation must NOT reject it.
    const r = gw.dispatch({ kind: 'spawnEntity', name: 'Root', parent: null, components: {} } as EditorOp, 'ai');
    expect(r.ok).toBe(true);
  });

  it('reparent{parent:null} (reparent to root) still succeeds (nullable regression guard)', () => {
    const child = gw.dispatch({ kind: 'spawnEntity', name: 'Child', parent: ent, components: {} } as EditorOp, 'ai');
    expect(child.ok).toBe(true);
    const childId = child.ok ? (child.result?.created?.[0] as number) : -1;
    const r = gw.dispatch({ kind: 'reparent', entity: childId, parent: null }, 'ai');
    expect(r.ok).toBe(true);
  });
});
