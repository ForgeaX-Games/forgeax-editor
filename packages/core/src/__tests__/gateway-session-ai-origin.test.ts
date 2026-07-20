// m2-w5 — TDD: session ops origin='ai' full matrix (RED phase)
//
// feat-20260706-editor-op-gateway-single-entry-b-catalog-defineop M2:
// AC-02 is the human/AI parity promise for the session domain: EVERY session op
// must be dispatchable with origin='ai', take effect, append exactly one
// origin-tagged ledger entry, and NOT grow the undo stack. AC-01 (basis): the
// ledger entry produced by origin='ai' is isomorphic to origin='human' for the
// same op except the origin field. m2-w1/w2 cover the representative clusters;
// this file is the per-kind exhaustive sweep.
//
// Constraints from upstream:
//   requirements AC-02: each session op, origin='ai' → effect + ledger + undo unchanged
//   requirements AC-01: human/AI ledger entries isomorphic modulo origin
//   plan-strategy §2 D-6: default origin='human' retained; AI passes 'ai' explicitly
//
// Anchors:
//   plan-tasks.json m2-w5

import { describe, expect, it, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { EditGateway } from '../io/gateway';
import type { EditorOp, EditSession } from '../types';
import { createEditSession } from '../session/document';
// Session-op appliers register as a side effect when their store module is
// evaluated (in the app the barrel loads all of them). A unit test that
// dispatches these kinds must import the owning modules so registration runs.
// M3 t22: write-side setter sugar deleted (S10) — reset via gw.dispatch.
// NOTE: frame-request applier migrated to edit-runtime (registerSessionApplier,
// D-11 pattern) — not imported here; requestFrame returns UNKNOWN_OP headless.
import '../store/selection';
import '../store/gizmo-mode';
import '../store/rename-request';
import '../store/scene-persistence';

function createSession(): EditSession {
  const s = createEditSession();
  s.world = new World();
  return s;
}

// Every builtin session op with a small, IO-free (or ledger-observable) body.
// (save/load/switch/create are also session ops but their real effect needs
// engine IO — their dispatch path + ledger is covered in m2-w2 (d).)
// requestFrame excluded: applier in edit-runtime (D-11 pattern), UNKNOWN_OP headless.
const SESSION_OPS: EditorOp[] = [
  { kind: 'setSelection', id: 5 } as EditorOp,
  { kind: 'setSelectionMany', ids: [1, 2] } as EditorOp,
  { kind: 'toggleSelection', id: 3 } as EditorOp,
  { kind: 'setGizmoMode', mode: 'rotate' } as EditorOp,
  { kind: 'requestRename', entity: 7 } as EditorOp,
  { kind: 'setSceneId', id: 'ai-level' } as EditorOp,
];

describe('session ops origin=ai — full matrix (m2-w5)', () => {
  let gw: EditGateway;
  beforeEach(() => { gw = new EditGateway(createSession()); gw.dispatch({ kind: 'setSelectionMany', ids: [] } as EditorOp); });

  for (const op of SESSION_OPS) {
    it(`${op.kind}: origin=ai → effect + ledger(origin=ai) + undo unchanged`, () => {
      const undoBefore = gw.appliedCount();
      const ledgerBefore = gw.ledger.length;
      const r = gw.dispatch(op, 'ai');
      expect(r.ok).toBe(true);
      // (b) ledger appended with origin=ai
      expect(gw.ledger.length).toBe(ledgerBefore + 1);
      expect(gw.origins[gw.origins.length - 1]).toBe('ai');
      expect(gw.ledger[gw.ledger.length - 1]!.kind).toBe(op.kind);
      // (c) undo stack unchanged
      expect(gw.appliedCount()).toBe(undoBefore);
    });
  }

  it('(d) origin=ai and origin=human ledger entries are isomorphic modulo origin', () => {
    const gwHuman = new EditGateway(createSession());
    const gwAi = new EditGateway(createSession());
    const op = { kind: 'setSelection', id: 42 } as EditorOp;
    gwHuman.dispatch(op, 'human');
    gwAi.dispatch(op, 'ai');
    const eHuman = gwHuman.ledger[gwHuman.ledger.length - 1]!;
    const eAi = gwAi.ledger[gwAi.ledger.length - 1]!;
    // The ledger entry (the op itself) is byte-identical; only the parallel
    // origins[] array differs.
    expect(eAi).toEqual(eHuman);
    expect(gwHuman.origins[gwHuman.origins.length - 1]).toBe('human');
    expect(gwAi.origins[gwAi.origins.length - 1]).toBe('ai');
  });

  it('default origin is human (D-6): omitting origin tags the entry human', () => {
    gw.dispatch({ kind: 'setSelection', id: 1 } as EditorOp);
    expect(gw.origins[gw.origins.length - 1]).toBe('human');
  });
});
