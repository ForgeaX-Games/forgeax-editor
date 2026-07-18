// m2-w11 — TDD: D-11 downstream registration seam, play/stop three states (RED)
//
// feat-20260706-editor-op-gateway-single-entry-b-catalog-defineop M2:
// play·stop are SESSION-domain discrete ops (op-kind 'play' / 'stop') whose real
// state machine lives in edit-runtime (DAG downstream — core must not import it).
// core exposes registerSessionApplier(kind, applier, meta?) so edit-runtime can
// register the real applier at boot (injection direction edit-runtime→core, same
// shape as the ApiClient seam — does not violate the DAG). This test pins the
// three states from the HEADLESS core perspective (no edit-runtime present):
//   (a) unregistered  → dispatch play → { ok:false, error:{ code:'UNKNOWN_OP', hint } }
//   (b) registered    → dispatch play (origin='ai') → applier called + effect +
//                       ledger entry origin='ai' + undo unchanged (session tier)
//   (c) unregistered again after the returned unregister fn → UNKNOWN_OP
//   (d) registering an already-registered kind → OP_ID_CONFLICT
//   (e) repeated same session op → ledger grows each time, undo never (boundary #6)
//
// The real play/stop applier behavior (the state machine) is M3 (edit-runtime);
// this file uses a test-double applier only.
//
// Constraints from upstream:
//   plan-strategy §2 D-11: seam two-state — unregistered → UNKNOWN_OP structured
//     error; registered → effect. headless core is the unregistered form (no
//     silent swallow).
//   requirements AC-02: play·stop AI-dispatchable (origin='ai'), enters ledger
//   plan-strategy §5.1: TDD — red test before the seam impl (m2-w12)
//
// Anchors:
//   plan-tasks.json m2-w11

import { describe, expect, it, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { EditGateway } from '../io/gateway';
import type { EditorOp, EditSession } from '../types';
import { createEditSession } from '../session/document';
import { registerSessionApplier } from '../io/appliers';

function createSession(): EditSession {
  const s = createEditSession();
  s.world = new World();
  return s;
}

describe('D-11 play/stop seam — three states (m2-w11)', () => {
  let gw: EditGateway;
  // Each test cleans up whatever it registered so the module-global session table
  // does not leak a 'play'/'stop' registration into later tests.
  const cleanups: Array<() => void> = [];
  beforeEach(() => {
    gw = new EditGateway(createSession());
    while (cleanups.length) cleanups.pop()!();
  });

  it('(a) unregistered: dispatch play → UNKNOWN_OP with an actionable hint', () => {
    const r = gw.dispatch({ kind: 'play' } as EditorOp);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('UNKNOWN_OP');
      // hint must point at the edit-runtime boot registration, not silently swallow
      expect(r.error.hint.length).toBeGreaterThan(0);
    }
  });

  it('(a) unregistered dispatch does NOT mutate ledger/undo (Fail Fast)', () => {
    const ledgerBefore = gw.ledger.length;
    const undoBefore = gw.appliedCount();
    gw.dispatch({ kind: 'stop' } as EditorOp);
    expect(gw.ledger.length).toBe(ledgerBefore);
    expect(gw.appliedCount()).toBe(undoBefore);
  });

  it('(b) registered test-double: dispatch play(origin=ai) → applier called + ledger + undo unchanged', () => {
    let called = 0;
    const unreg = registerSessionApplier('play', () => { called++; return { ok: true }; });
    cleanups.push(unreg);

    const ledgerBefore = gw.ledger.length;
    const undoBefore = gw.appliedCount();
    const r = gw.dispatch({ kind: 'play' } as EditorOp, 'ai');
    expect(r.ok).toBe(true);
    expect(called).toBe(1);
    // session tier: ledger grows, undo does not
    expect(gw.ledger.length).toBe(ledgerBefore + 1);
    expect(gw.origins[gw.origins.length - 1]).toBe('ai');
    expect(gw.appliedCount()).toBe(undoBefore);
  });

  it('(c) after unregister, play returns UNKNOWN_OP again (clean state restored)', () => {
    const unreg = registerSessionApplier('play', () => ({ ok: true }));
    expect(gw.dispatch({ kind: 'play' } as EditorOp).ok).toBe(true);
    unreg();
    const r = gw.dispatch({ kind: 'play' } as EditorOp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNKNOWN_OP');
  });

  it('(d) registering an already-registered kind → OP_ID_CONFLICT', () => {
    const unreg = registerSessionApplier('play', () => ({ ok: true }));
    cleanups.push(unreg);
    expect(() => registerSessionApplier('play', () => ({ ok: true }))).toThrow();
    // The conflict must not have clobbered the first registration.
    expect(gw.dispatch({ kind: 'play' } as EditorOp).ok).toBe(true);
  });

  it('(d) OP_ID_CONFLICT is a structured code (thrown error carries it)', () => {
    const unreg = registerSessionApplier('stop', () => ({ ok: true }));
    cleanups.push(unreg);
    let code: string | undefined;
    try {
      registerSessionApplier('stop', () => ({ ok: true }));
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe('OP_ID_CONFLICT');
  });

  it('(e) repeated same session op grows ledger each time, undo never (boundary #6)', () => {
    const unreg = registerSessionApplier('play', () => ({ ok: true }));
    cleanups.push(unreg);
    const ledgerBefore = gw.ledger.length;
    const undoBefore = gw.appliedCount();
    gw.dispatch({ kind: 'play' } as EditorOp, 'ai');
    gw.dispatch({ kind: 'play' } as EditorOp, 'ai');
    gw.dispatch({ kind: 'play' } as EditorOp, 'ai');
    expect(gw.ledger.length).toBe(ledgerBefore + 3);
    expect(gw.appliedCount()).toBe(undoBefore);
  });

  it('a failing test-double applier surfaces its structured error', () => {
    const unreg = registerSessionApplier('play', () => ({ ok: false, error: { code: 'PLAN_FAILED', hint: 'boom' } }));
    cleanups.push(unreg);
    const ledgerBefore = gw.ledger.length;
    const r = gw.dispatch({ kind: 'play' } as EditorOp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PLAN_FAILED');
    // Fail Fast: a failed applier leaves no ledger residue.
    expect(gw.ledger.length).toBe(ledgerBefore);
  });
});
