// m2-w3 — TDD: transient-domain routing for hover / field-preview /
// asset-selection (RED phase)
//
// feat-20260706-editor-op-gateway-single-entry-b-catalog-defineop M2:
// setHoverEntity / setFieldPreview / setAssetSelection are collected as
// TRANSIENT-domain ops. They route through the SAME single gateway door but
// leave NO trace: not undo, not ledger. Listeners still fire (UI updates), the
// op is explicitly classified transient (not forgotten in the store). At RED
// (before m2-w9) transientAppliers lacks these kinds → dispatch returns
// UNKNOWN_OP.
//
// Constraints from upstream:
//   requirements AC-03: transient goes through the gateway but leaves no trace —
//     listeners receive it, UI takes effect, undo/ledger unchanged
//   requirements §2 NOTE: asset-selection belongs to transient (q2 human answer)
//   plan-strategy §1 CAUTION: override spec §5.2 two-domain stance — transient
//     goes through the one door but is not ledgered
//
// Anchors:
//   plan-tasks.json m2-w3
//   requirements §2 domain table: hover / field-preview / asset-selection = transient

import { describe, expect, it, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { EditGateway } from '../io/gateway';
import type { EditorOp, EditSession } from '../types';
import { createEditSession } from '../session/document';
import { setHoverEntity, getHoverEntity } from '../store/hover';
import { setFieldPreview, getFieldPreview } from '../store/field-preview';
import {
  setAssetSelection,
  getAssetSelection,
  onAssetSelectionChange,
  type SelectedAsset,
} from '../store/asset-selection';

function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

const asset = (guid: string): SelectedAsset => ({
  guid, kind: 'material', name: guid, payload: {}, packPath: 'x.pack.json',
});

describe('transient routing — hover (m2-w3)', () => {
  let gw: EditGateway;
  beforeEach(() => { gw = new EditGateway(createSession()); setHoverEntity(null); });

  it('(a) setHoverEntity op takes effect via gateway dispatch', () => {
    const r = gw.dispatch({ kind: 'setHoverEntity', id: 12 } as EditorOp);
    expect(r.ok).toBe(true);
    expect(getHoverEntity()).toBe(12);
  });

  it('(b)+(c) transient op does NOT grow undo OR ledger', () => {
    const undoBefore = gw.appliedCount();
    const ledgerBefore = gw.ledger.length;
    gw.dispatch({ kind: 'setHoverEntity', id: 4 } as EditorOp);
    expect(gw.appliedCount()).toBe(undoBefore);
    expect(gw.ledger.length).toBe(ledgerBefore); // transient: no ledger entry
  });

  it('(e) hover op is AI-dispatchable', () => {
    const r = gw.dispatch({ kind: 'setHoverEntity', id: 6 } as EditorOp, 'ai');
    expect(r.ok).toBe(true);
    expect(getHoverEntity()).toBe(6);
    // origin is not recorded because transient ops do not enter origins[]
    expect(gw.origins.length).toBe(0);
  });

  it('the setHoverEntity setter delegates through the gateway', () => {
    setHoverEntity(21);
    expect(getHoverEntity()).toBe(21);
  });
});

describe('transient routing — field-preview (m2-w3)', () => {
  let gw: EditGateway;
  beforeEach(() => { gw = new EditGateway(createSession()); setFieldPreview(null); });

  it('(a) setFieldPreview op takes effect via gateway dispatch', () => {
    const r = gw.dispatch({ kind: 'setFieldPreview', id: 3, key: 'Transform.rot.y', value: 1.5 } as EditorOp);
    expect(r.ok).toBe(true);
    expect(getFieldPreview()).toEqual({ id: 3, key: 'Transform.rot.y', value: 1.5 });
  });

  it('(b)+(c) field-preview leaves no trace (undo + ledger unchanged)', () => {
    const undoBefore = gw.appliedCount();
    const ledgerBefore = gw.ledger.length;
    gw.dispatch({ kind: 'setFieldPreview', id: 9, key: 'Transform.pos.x', value: 2 } as EditorOp);
    expect(gw.appliedCount()).toBe(undoBefore);
    expect(gw.ledger.length).toBe(ledgerBefore);
  });

  it('the setFieldPreview setter delegates through the gateway', () => {
    setFieldPreview(5, 'Transform.scale.x', 3);
    expect(getFieldPreview()).toEqual({ id: 5, key: 'Transform.scale.x', value: 3 });
  });
});

describe('transient routing — asset-selection (m2-w3)', () => {
  let gw: EditGateway;
  beforeEach(() => { gw = new EditGateway(createSession()); setAssetSelection(null); });

  it('(a) setAssetSelection op takes effect via gateway dispatch', () => {
    const a = asset('mat-1');
    const r = gw.dispatch({ kind: 'setAssetSelection', asset: a } as EditorOp);
    expect(r.ok).toBe(true);
    expect(getAssetSelection()?.guid).toBe('mat-1');
  });

  it('(b)+(c) asset-selection leaves no trace (undo + ledger unchanged)', () => {
    const undoBefore = gw.appliedCount();
    const ledgerBefore = gw.ledger.length;
    gw.dispatch({ kind: 'setAssetSelection', asset: asset('mat-2') } as EditorOp);
    expect(gw.appliedCount()).toBe(undoBefore);
    expect(gw.ledger.length).toBe(ledgerBefore);
  });

  it('(d) listeners receive the change even though it is not ledgered', () => {
    let fired = 0;
    const unsub = onAssetSelectionChange(() => { fired++; });
    gw.dispatch({ kind: 'setAssetSelection', asset: asset('mat-3') } as EditorOp);
    unsub();
    expect(fired).toBe(1);
    expect(getAssetSelection()?.guid).toBe('mat-3');
  });

  it('the setAssetSelection setter delegates through the gateway', () => {
    setAssetSelection(asset('mat-4'));
    expect(getAssetSelection()?.guid).toBe('mat-4');
  });
});
