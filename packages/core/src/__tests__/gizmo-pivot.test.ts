// gizmo-pivot — session-domain routing for setGizmoPivot (gizmo-ue-parity plan §M3).
//
// UE parity: the multi-selection gizmo anchor defaults to 'center' (average of
// selected pivots) and can be switched to 'lastSelected'. The switch is a
// session op: ledger-only (no undo), human and AI dispatch the SAME op
// (north-star single door), and out-of-enum values fail fast with INVALID_ARGS.

import { describe, expect, it, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { EditGateway } from '../io/gateway';
import type { EditorOp, EditSession } from '../types';
import { createEditSession } from '../session/document';
import { getGizmoPivot, onGizmoPivotChange } from '../store/gizmo-pivot';

function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

describe('session routing — gizmo-pivot (gizmo-ue-parity M3)', () => {
  let gw: EditGateway;
  beforeEach(() => {
    gw = new EditGateway(createSession());
    // gizmo-pivot state is module-global — reset to the UE default between tests.
    gw.dispatch({ kind: 'setGizmoPivot', pivot: 'center' } as EditorOp);
  });

  it('(a) default pivot is center (UE default)', () => {
    expect(getGizmoPivot()).toBe('center');
  });

  it('(b) setGizmoPivot switches the mode via gateway dispatch', () => {
    const r = gw.dispatch({ kind: 'setGizmoPivot', pivot: 'lastSelected' } as EditorOp);
    expect(r.ok).toBe(true);
    expect(getGizmoPivot()).toBe('lastSelected');
  });

  it('(c) setGizmoPivot grows ledger, not undo', () => {
    const undoBefore = gw.appliedCount();
    const ledgerBefore = gw.ledger.length;
    gw.dispatch({ kind: 'setGizmoPivot', pivot: 'lastSelected' } as EditorOp);
    expect(gw.ledger.length).toBe(ledgerBefore + 1);
    expect(gw.appliedCount()).toBe(undoBefore);
  });

  it('(d) setGizmoPivot is AI-dispatchable with a distinguishable origin', () => {
    const r = gw.dispatch({ kind: 'setGizmoPivot', pivot: 'lastSelected' } as EditorOp, 'ai');
    expect(r.ok).toBe(true);
    expect(gw.origins[gw.origins.length - 1]).toBe('ai');
  });

  it('(e) out-of-enum pivot → INVALID_ARGS, no ledger residue', () => {
    const before = gw.ledger.length;
    const r = gw.dispatch({ kind: 'setGizmoPivot', pivot: 'middle' } as unknown as EditorOp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
    expect(gw.ledger.length).toBe(before);
    expect(getGizmoPivot()).toBe('center');
  });

  it('(f) listeners fire only on an actual change', () => {
    let calls = 0;
    const unsub = onGizmoPivotChange(() => { calls++; });
    gw.dispatch({ kind: 'setGizmoPivot', pivot: 'lastSelected' } as EditorOp);
    gw.dispatch({ kind: 'setGizmoPivot', pivot: 'lastSelected' } as EditorOp);
    gw.dispatch({ kind: 'setGizmoPivot', pivot: 'center' } as EditorOp);
    unsub();
    expect(calls).toBe(2);
  });
});
