// m2-w1 — TDD: session-domain routing for selection + gizmo-mode (RED phase)
//
// feat-20260706-editor-op-gateway-single-entry-b-catalog-defineop M2:
// selection (setSelection/toggleSelection/setSelectionMany) and gizmo-mode
// (setGizmoMode) are collected as SESSION-domain ops — they route through the
// gateway, land in the append-only ledger, but never enter the undo stack (no
// inverse). At RED phase (before m2-w6) sessionAppliers is empty, so dispatch of
// these kinds returns UNKNOWN_OP and every assertion here fails. m2-w6 registers
// the appliers + points the setters at the gateway → GREEN.
//
// Constraints from upstream:
//   plan-strategy §2 D-1: applier registration table determines domain (structural)
//   requirements AC-02: each session op is AI-dispatchable (origin='ai'), lands
//     in ledger, undo stack does NOT grow
//   requirements boundary #6 / plan-strategy §5.5: ledger is flat append-only,
//     zero write-side exceptions — a repeated same-value dispatch still grows it
//   research F2: selection.ts / gizmo-mode.ts setters are tiny — collect by
//     changing the door, not by rewriting the body
//
// Anchors:
//   plan-tasks.json m2-w1: session routing (selection + gizmo-mode) TDD
//   requirements §2 domain table: selection / gizmo-mode belong to session domain

import { describe, expect, it, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { EditGateway } from '../io/gateway';
import type { EditorOp, EditSession } from '../types';
import { createEditSession } from '../session/document';
// M3 t22: the write-side setter sugar was deleted (S10 / AC-21/22). Tests
// dispatch through the gateway door directly; the imports keep read-side
// accessors and trigger applier registration (module-eval side effect).
import {
  getSelection,
  getSelectionList,
} from '../store/selection';
import { getGizmoMode } from '../store/gizmo-mode';
import { gateway } from '../store/gateway';

function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

// Selection / gizmo-mode state is module-global (not per-gateway), so reset it
// between tests. A fresh EditGateway isolates the ledger/undo per test.
function resetState(gw: EditGateway): void {
  gw.dispatch({ kind: 'setSelectionMany', ids: [] } as EditorOp);
  gw.dispatch({ kind: 'setGizmoMode', mode: 'translate' } as EditorOp);
}

describe('session routing — selection (m2-w1)', () => {
  let gw: EditGateway;
  beforeEach(() => { gw = new EditGateway(createSession()); gw.dispatch({ kind: 'setSelectionMany', ids: [] } as EditorOp); });

  it('(a) setSelection op takes effect via gateway dispatch', () => {
    const r = gw.dispatch({ kind: 'setSelection', id: 7 } as EditorOp);
    expect(r.ok).toBe(true);
    expect(getSelection()).toBe(7 as never);
  });

  it('(a) setSelectionMany op sets the whole list', () => {
    const r = gw.dispatch({ kind: 'setSelectionMany', ids: [3, 4, 5] } as EditorOp);
    expect(r.ok).toBe(true);
    expect([...getSelectionList()]).toEqual([3, 4, 5] as never);
  });

  it('(a) toggleSelection op toggles membership (last-clicked = primary)', () => {
    gw.dispatch({ kind: 'setSelectionMany', ids: [1, 2] } as EditorOp);
    gw.dispatch({ kind: 'toggleSelection', id: 3 } as EditorOp); // add
    expect([...getSelectionList()]).toEqual([1, 2, 3] as never);
    gw.dispatch({ kind: 'toggleSelection', id: 2 } as EditorOp); // remove
    expect([...getSelectionList()]).toEqual([1, 3] as never);
  });

  it('(b) session op grows the ledger but NOT the undo stack', () => {
    const undoBefore = gw.appliedCount();
    const ledgerBefore = gw.ledger.length;
    gw.dispatch({ kind: 'setSelection', id: 9 } as EditorOp);
    expect(gw.ledger.length).toBe(ledgerBefore + 1);
    expect(gw.appliedCount()).toBe(undoBefore); // undo stack frozen — no inverse
    expect(gw.ledger[gw.ledger.length - 1]!.kind).toBe('setSelection');
  });

  it('(c) session op is AI-dispatchable (origin=ai) and takes effect', () => {
    const originsBefore = gw.origins.length;
    const r = gw.dispatch({ kind: 'setSelection', id: 11 } as EditorOp, 'ai');
    expect(r.ok).toBe(true);
    expect(getSelection()).toBe(11 as never);
    expect(gw.origins.length).toBe(originsBefore + 1);
    expect(gw.origins[gw.origins.length - 1]).toBe('ai');
  });

  it('(d) a repeated same-value dispatch STILL grows the ledger (zero write-side exception)', () => {
    gw.dispatch({ kind: 'setSelectionMany', ids: [5] } as EditorOp);
    const ledgerBefore = gw.ledger.length;
    // setSelection(5) when 5 is already primary — the tiny setter body early-returns
    // on no-op, but the ledger contract is flat append-only: the op reached the
    // gateway and was applied, so it is recorded. (The applier itself decides
    // whether the state changed; the ledger records the dispatched op.)
    gw.dispatch({ kind: 'setSelectionMany', ids: [5] } as EditorOp);
    gw.dispatch({ kind: 'setSelectionMany', ids: [5] } as EditorOp);
    expect(gw.ledger.length).toBe(ledgerBefore + 2);
  });

  it('selection ops dispatched through the singleton gateway change state', () => {
    gateway.dispatch({ kind: 'setSelection', id: 42 } as EditorOp);
    expect(getSelection()).toBe(42 as never);
    gateway.dispatch({ kind: 'setSelection', id: null } as EditorOp);
    expect(getSelection()).toBe(null);
    gateway.dispatch({ kind: 'toggleSelection', id: 8 } as EditorOp);
    expect([...getSelectionList()]).toEqual([8] as never);
  });
});

describe('session routing — gizmo-mode (m2-w1)', () => {
  let gw: EditGateway;
  beforeEach(() => { gw = new EditGateway(createSession()); resetState(gw); });

  it('(a) setGizmoMode op switches the mode via gateway dispatch', () => {
    const r = gw.dispatch({ kind: 'setGizmoMode', mode: 'rotate' } as EditorOp);
    expect(r.ok).toBe(true);
    expect(getGizmoMode()).toBe('rotate');
  });

  it('(b) setGizmoMode grows ledger, not undo', () => {
    const undoBefore = gw.appliedCount();
    const ledgerBefore = gw.ledger.length;
    gw.dispatch({ kind: 'setGizmoMode', mode: 'scale' } as EditorOp);
    expect(gw.ledger.length).toBe(ledgerBefore + 1);
    expect(gw.appliedCount()).toBe(undoBefore);
  });

  it('(c) setGizmoMode is AI-dispatchable with a distinguishable origin', () => {
    const r = gw.dispatch({ kind: 'setGizmoMode', mode: 'rotate' } as EditorOp, 'ai');
    expect(r.ok).toBe(true);
    expect(gw.origins[gw.origins.length - 1]).toBe('ai');
  });

  it('setGizmoMode dispatched through the singleton gateway changes mode', () => {
    gateway.dispatch({ kind: 'setGizmoMode', mode: 'scale' } as EditorOp);
    expect(getGizmoMode()).toBe('scale');
  });
});
