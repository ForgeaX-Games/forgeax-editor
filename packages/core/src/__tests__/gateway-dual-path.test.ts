// m3-w1 — TDD: human/AI dual-path isomorphism (AC-01)
//
// feat-20260706-editor-op-gateway-single-entry-b-catalog-defineop M3:
// AC-01 is the load-bearing "human = AI" promise: a human UI handler and an AI
// tool-call that dispatch the SAME op reach the SAME gateway, run the SAME
// applier, and produce ledger entries that are byte-identical except for the
// origin tag. It also pins the continuous-op (gizmo) contract: a
// begin -> update*N -> commit lifecycle grows the undo stack by exactly ONE
// (not one per frame), and the committed world state equals a single immediate
// dispatch of the same final op.
//
// This is a UNIT-level test (plan-strategy §5.2: e2e/visual belong to AC-06;
// AC-10 feel is manual). It does NOT drive the real viewport UI — it simulates a
// UI handler by calling the gateway directly, which is exactly the seam AC-01
// asserts: both roles funnel through gateway.dispatch / begin…commit.
//
// Constraints from upstream:
//   requirements AC-01: human/AI dual path — same gateway, same applier, ledger
//     entry isomorphic modulo origin, gizmo undo grows by one
//   plan-strategy §2 D-2: continuous op commit = ONE from->to inverse (multi-frame
//     drag undoes in a single step)
//   plan-strategy §5.3: key test point — dual-path ledger isomorphism
//
// Anchors:
//   plan-tasks.json m3-w1

import { describe, expect, it, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-runtime';
import type { EntityHandle } from '../scene/scene-types';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';
import type { EditorOp, EditSession, CommandError } from '../types';
// Session-op appliers register as a side effect when their store module is
// evaluated (the barrel loads all of them in the app). A unit test that
// dispatches a session kind must import the owning module so registration runs.
// M3 t22: the write-side setter sugar was deleted (S10) — dispatch through the
// singleton gateway door directly; the side-effect import keeps registration.
import '../store/selection';
import { gateway } from '../store/gateway';

function createSession(): EditSession {
  const s = createEditSession();
  s.world = new World();
  return s;
}

function spawnBox(gw: EditGateway, posX = 0): number {
  const cmd: EditorOp = {
    kind: 'spawnEntity',
    name: 'box',
    components: { Transform: { posX, posY: 0, posZ: 0 } },
  } as EditorOp;
  const r = gw.dispatch(cmd);
  if (!r.ok) throw new Error(`spawn failed: ${(r as { error: CommandError }).error.hint}`);
  return (cmd as { _id?: number })._id!;
}

function readPosX(gw: EditGateway, entity: number): number {
  const h = (entity as EntityHandle) as EntityHandle;
  const tr = gw.doc.world.get(h, Transform);
  if (!tr.ok) throw new Error('Transform not on entity');
  return (tr.value as unknown as { posX: number }).posX;
}

describe('AC-01 dual-path isomorphism — document domain (m3-w1)', () => {
  it('(a)+(b) same document op dispatched human vs ai → same applier, ledger entry isomorphic modulo origin', () => {
    // Two independent gateways so their entity ids line up 1:1; the only intended
    // difference is the origin tag on the parallel origins[] array.
    const gwHuman = new EditGateway(createSession());
    const gwAi = new EditGateway(createSession());
    const idH = spawnBox(gwHuman);
    const idA = spawnBox(gwAi);
    expect(idH).toBe(idA); // deterministic id allocation — same op, same id

    // The SAME op object (a human UI handler and an AI tool-call would build the
    // identical plain-JSON payload). setComponent is a document op → applyCommand.
    const op = { kind: 'setComponent', entity: idH, component: 'Transform', patch: { posX: 9 } } as EditorOp;
    const rH = gwHuman.dispatch(op, 'human');
    const rA = gwAi.dispatch(op, 'ai');
    expect(rH.ok).toBe(true);
    expect(rA.ok).toBe(true);

    // Same applier ran on both paths → identical world effect.
    expect(readPosX(gwHuman, idH)).toBe(9);
    expect(readPosX(gwAi, idA)).toBe(9);

    // Ledger entries (the op payload itself) are byte-identical …
    const eH = gwHuman.ledger[gwHuman.ledger.length - 1]!;
    const eA = gwAi.ledger[gwAi.ledger.length - 1]!;
    expect(eA).toEqual(eH);
    // … and ONLY the parallel origins[] differs.
    expect(gwHuman.origins[gwHuman.origins.length - 1]).toBe('human');
    expect(gwAi.origins[gwAi.origins.length - 1]).toBe('ai');
  });

  it('default origin is human (D-6): a UI handler omits origin and is tagged human', () => {
    const gw = new EditGateway(createSession());
    const id = spawnBox(gw);
    gw.dispatch({ kind: 'setComponent', entity: id, component: 'Transform', patch: { posX: 1 } } as EditorOp);
    expect(gw.origins[gw.origins.length - 1]).toBe('human');
  });
});

describe('AC-01 dual-path isomorphism — session domain (m3-w1)', () => {
  beforeEach(() => { gateway.dispatch({ kind: 'setSelectionMany', ids: [] } as EditorOp); });

  it('(a)+(b) same session op dispatched human vs ai → ledger entry isomorphic modulo origin, undo unchanged', () => {
    const gwHuman = new EditGateway(createSession());
    const gwAi = new EditGateway(createSession());
    const op = { kind: 'setSelection', id: 42 } as EditorOp;
    const undoBefore = gwAi.appliedCount();

    gwHuman.dispatch(op, 'human');
    gwAi.dispatch(op, 'ai');

    const eH = gwHuman.ledger[gwHuman.ledger.length - 1]!;
    const eA = gwAi.ledger[gwAi.ledger.length - 1]!;
    expect(eA).toEqual(eH);
    expect(gwHuman.origins[gwHuman.origins.length - 1]).toBe('human');
    expect(gwAi.origins[gwAi.origins.length - 1]).toBe('ai');
    // session tier: ledger grew, undo did not (AC-02 basis).
    expect(gwAi.appliedCount()).toBe(undoBefore);
  });
});

describe('AC-01 gizmo continuous op — begin/update*/commit (m3-w1)', () => {
  it('(c) begin -> update x3 -> commit grows the undo stack by exactly ONE (not per-frame)', () => {
    const gw = new EditGateway(createSession());
    const id = spawnBox(gw, 0);
    const undoBefore = gw.appliedCount();
    const ledgerBefore = gw.ledger.length;

    const b = gw.begin({ kind: 'setComponent', entity: id, component: 'Transform', patch: { posX: 0 } } as EditorOp);
    expect(b.ok).toBe(true);
    if (!b.ok) throw new Error('begin failed');
    // Three drag frames.
    gw.update(b.handle, { patch: { posX: 1 } });
    gw.update(b.handle, { patch: { posX: 2 } });
    gw.update(b.handle, { patch: { posX: 3 } });
    // (d) update phase: the entity changes live (mid-drag readable state).
    expect(readPosX(gw, id)).toBe(3);
    gw.commit(b.handle);

    // Exactly one undo entry + one ledger entry for the whole drag.
    expect(gw.appliedCount()).toBe(undoBefore + 1);
    expect(gw.ledger.length).toBe(ledgerBefore + 1);

    // One undo reverts the entire drag to the pre-begin pose (D-2 single inverse).
    gw.undo();
    expect(readPosX(gw, id)).toBe(0);
  });

  it('(d) committed world state equals a single immediate dispatch of the same final op', () => {
    // Path 1: continuous begin/update/commit ending at posX=7.
    const gwLifecycle = new EditGateway(createSession());
    const idL = spawnBox(gwLifecycle, 0);
    const b = gwLifecycle.begin({ kind: 'setComponent', entity: idL, component: 'Transform', patch: { posX: 0 } } as EditorOp);
    if (!b.ok) throw new Error('begin failed');
    gwLifecycle.update(b.handle, { patch: { posX: 4 } });
    gwLifecycle.update(b.handle, { patch: { posX: 7 } });
    gwLifecycle.commit(b.handle);

    // Path 2: one immediate dispatch straight to posX=7.
    const gwDispatch = new EditGateway(createSession());
    const idD = spawnBox(gwDispatch, 0);
    gwDispatch.dispatch({ kind: 'setComponent', entity: idD, component: 'Transform', patch: { posX: 7 } } as EditorOp);

    // Same final world state on both paths.
    expect(readPosX(gwLifecycle, idL)).toBe(readPosX(gwDispatch, idD));
    expect(readPosX(gwLifecycle, idL)).toBe(7);
  });
});
