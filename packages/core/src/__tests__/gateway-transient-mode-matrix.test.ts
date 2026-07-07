// m2-w4 — TDD: transientMode x three-domain matrix (RED phase)
//
// feat-20260706-editor-op-gateway-single-entry-b-catalog-defineop M2:
// transientMode (play·scene / UE Simulate non-committing edit) extends from
// gating only the document domain to gating ALL THREE domains uniformly: while
// true, every op STILL routes through the gateway and STILL applies + emits, but
// NONE writes to undo/ledger. This test pins the full 6-cell matrix
// (document/session/transient x transientMode off/on).
//
// off baseline (already covered by m2-w1/w2/w3, restated here as the matrix
// control):
//   document -> undo + ledger
//   session  -> ledger only
//   transient-> neither
// on:
//   document -> applies + emits, no undo, no ledger
//   session  -> applies, no ledger
//   transient-> applies, no ledger (same as off for transient)
//
// Constraints from upstream:
//   requirements AC-09: under transientMode all three domains still route through
//     the gateway, uniformly skipping undo/ledger writes (single entry, no mode
//     exception)
//   plan-strategy §4 R4: transientMode extended (existing boolean gate, not a new
//     mechanism)
//   research R4: transientMode's only read point is the gateway
//
// Anchors:
//   plan-tasks.json m2-w4

import { describe, expect, it, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-runtime';
import type { EntityHandle } from '../scene/scene-types';
import { EditGateway } from '../io/gateway';
import { entHandle } from '../store/entity-state';
import type { EditorOp, EditSession } from '../types';
import { getSelection, setSelectionMany } from '../store/selection';
import { getHoverEntity, setHoverEntity } from '../store/hover';
import { createEditSession } from '../session/document';

function createSession(): EditSession {
  const s = createEditSession();
  s.world = new World();
  return s;
}

function spawn(gw: EditGateway, name: string): number {
  const cmd: EditorOp = { kind: 'spawnEntity', name, components: { Transform: { posX: 0, posY: 0, posZ: 0 } } };
  const r = gw.dispatch(cmd);
  if (!r.ok) throw new Error('spawn failed');
  return cmd._id!;
}

function readPosX(gw: EditGateway, entity: number): number {
  const h = entHandle(gw.doc, entity) as EntityHandle;
  const tr = gw.doc.world.get(h, Transform);
  if (!tr.ok) throw new Error('no Transform');
  return (tr.value as unknown as { posX: number }).posX;
}

const move = (entity: number, posX: number): EditorOp =>
  ({ kind: 'setComponent', entity, component: 'Transform', patch: { posX } });

describe('transientMode matrix — document domain (m2-w4)', () => {
  let gw: EditGateway;
  beforeEach(() => { gw = new EditGateway(createSession()); });

  it('off: document op -> undo + ledger', () => {
    const id = spawn(gw, 'box');
    const undoBefore = gw.appliedCount();
    const ledgerBefore = gw.ledger.length;
    gw.dispatch(move(id, 5));
    expect(gw.appliedCount()).toBe(undoBefore + 1);
    expect(gw.ledger.length).toBe(ledgerBefore + 1);
    expect(readPosX(gw, id)).toBe(5);
  });

  it('on: document op applies + emits, but no undo, no ledger', () => {
    const id = spawn(gw, 'box');
    const undoBefore = gw.appliedCount();
    const ledgerBefore = gw.ledger.length;
    const revBefore = gw.rev;
    gw.transientMode = true;
    const r = gw.dispatch(move(id, 42));
    expect(r.ok).toBe(true);
    expect(readPosX(gw, id)).toBe(42);          // world changed (applied)
    expect(gw.rev).toBeGreaterThan(revBefore);  // emitted (repaint)
    expect(gw.appliedCount()).toBe(undoBefore); // no undo
    expect(gw.ledger.length).toBe(ledgerBefore); // no ledger
  });
});

describe('transientMode matrix — session domain (m2-w4)', () => {
  let gw: EditGateway;
  beforeEach(() => { gw = new EditGateway(createSession()); setSelectionMany([]); });

  it('off: session op -> ledger only', () => {
    const undoBefore = gw.appliedCount();
    const ledgerBefore = gw.ledger.length;
    gw.dispatch({ kind: 'setSelection', id: 3 } as EditorOp);
    expect(gw.appliedCount()).toBe(undoBefore);
    expect(gw.ledger.length).toBe(ledgerBefore + 1);
  });

  it('on: session op applies, but no ledger', () => {
    const undoBefore = gw.appliedCount();
    const ledgerBefore = gw.ledger.length;
    gw.transientMode = true;
    const r = gw.dispatch({ kind: 'setSelection', id: 8 } as EditorOp);
    expect(r.ok).toBe(true);
    expect(getSelection()).toBe(8);             // applied
    expect(gw.appliedCount()).toBe(undoBefore); // no undo
    expect(gw.ledger.length).toBe(ledgerBefore); // no ledger under transientMode
  });
});

describe('transientMode matrix — transient domain (m2-w4)', () => {
  let gw: EditGateway;
  beforeEach(() => { gw = new EditGateway(createSession()); setHoverEntity(null); });

  it('off: transient op -> neither undo nor ledger', () => {
    const undoBefore = gw.appliedCount();
    const ledgerBefore = gw.ledger.length;
    gw.dispatch({ kind: 'setHoverEntity', id: 2 } as EditorOp);
    expect(gw.appliedCount()).toBe(undoBefore);
    expect(gw.ledger.length).toBe(ledgerBefore);
    expect(getHoverEntity()).toBe(2);
  });

  it('on: transient op applies, still neither undo nor ledger', () => {
    const undoBefore = gw.appliedCount();
    const ledgerBefore = gw.ledger.length;
    gw.transientMode = true;
    const r = gw.dispatch({ kind: 'setHoverEntity', id: 5 } as EditorOp);
    expect(r.ok).toBe(true);
    expect(getHoverEntity()).toBe(5);           // applied
    expect(gw.appliedCount()).toBe(undoBefore);
    expect(gw.ledger.length).toBe(ledgerBefore);
  });
});
