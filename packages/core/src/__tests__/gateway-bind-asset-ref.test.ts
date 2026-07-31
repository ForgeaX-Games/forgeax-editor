// bindAssetRef (session) op registration + validation contract.
//
// solo round-11 / P5 rendering-authoring convergence: a catalogued asset GUID had
// NO front-door path into a shared<T> component field. `addComponent`/`setComponent`
// pass value RAW (no GUID->handle resolution), so a GUID written into
// MeshRenderer.materials / Skylight.equirect / AnimationPlayer.clips silently
// coerced to handle 0 (the P5 material gap == the P6 clip gap: one missing
// capability, three fields). This test pins the fix (the binder is now AI-
// discoverable via listOps + AI-dispatchable), and would have FAILED before it
// (no op -> hasOp false, dispatch -> UNKNOWN_OP):
//   - bindAssetRef is a SESSION-domain op, cataloged (AI-discoverable via listOps),
//     with entity/component/field/assetType/guids/requestId as required args.
//   - dispatching it with valid args is accepted with an independent OperationRun;
//     the loadByGuid -> allocSharedRef -> setComponent completion is queryable.
//   - dispatching it with a missing/empty required arg fails fast with a STRUCTURED
//     error (INVALID_ARGS), never a silent no-op (charter P3 / Fail Fast).
//
// The full GUID->handle resolution + round-trip needs a LIVE world/registry (the
// live-drive verify step in the round REPORT proves that end-to-end); this unit
// pins the front-door contract the friction was about.

import { describe, expect, it, beforeEach } from 'bun:test';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';
import { hasOp, getOp, listOps } from '../io/catalog';
// Importing the barrel loads spawn-asset-ref's side-effect (session applier
// registration), exactly as the app boot does.
import '../index';
import type { EditSession } from '../types';

describe('bindAssetRef op registration (catalog SSOT)', () => {
  it('bindAssetRef is a cataloged SESSION op (AI-discoverable)', () => {
    expect(hasOp('bindAssetRef')).toBe(true);
    expect(getOp('bindAssetRef')?.domain).toBe('session');
    const op = listOps().find((o) => o.id === 'bindAssetRef');
    expect(op?.domain).toBe('session');
    // argsSchema drives AI self-discovery — the binder inputs + correlation id are required.
    for (const req of ['entity', 'component', 'field', 'assetType', 'guids', 'requestId']) {
      expect(op?.argsSchema?.required).toContain(req);
    }
    expect(op?.operationRun?.read.wait).toBe('waitOperationRun');
    expect(op?.operationRun?.cancellable).toBe(false);
  });

  it('argsSchema documents the shared<T> class it closes + the owned-entity limit', () => {
    const op = listOps().find((o) => o.id === 'bindAssetRef');
    const props = op?.argsSchema?.properties ?? {};
    // guids description names it as catalogued GUIDs (the input the AI supplies).
    expect(String(props.guids?.description ?? '')).toMatch(/catalogued|catalog/i);
    // entity description must warn a mount MEMBER needs the engine mount-override
    // round-trip, not this op (keeps the P6 escalation boundary honest).
    expect(String(props.entity?.description ?? '')).toMatch(/mount|owned/i);
  });
});

describe('bindAssetRef dispatch (session applier)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    const session: EditSession = createEditSession();
    session.world = {} as never;
    gw = new EditGateway(session);
  });

  it('missing entity fails fast with a STRUCTURED error (not a silent no-op)', () => {
    const r = gw.dispatch({ kind: 'bindAssetRef', component: 'MeshRenderer', field: 'materials', assetType: 'MaterialAsset', guids: ['x'] } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
  });

  it('empty guids array fails fast with a STRUCTURED error', () => {
    const r = gw.dispatch({ kind: 'bindAssetRef', entity: 1, component: 'MeshRenderer', field: 'materials', assetType: 'MaterialAsset', guids: [] } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
  });

  it('missing assetType fails fast with a STRUCTURED error', () => {
    const r = gw.dispatch({ kind: 'bindAssetRef', entity: 1, component: 'Skylight', field: 'equirect', guids: ['x'] } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
  });

  it('valid args are accepted with an independently queryable OperationRun', async () => {
    const r = gw.dispatch({
      kind: 'bindAssetRef',
      entity: 2,
      component: 'MeshRenderer',
      field: 'materials',
      assetType: 'MaterialAsset',
      guids: ['019f56f2-0ac0-776a-9d28-50eaf795daed'],
      slot: 0,
      requestId: 'bind-asset-run-1',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result?.operationRun?.requestId).toBe('bind-asset-run-1');
    const terminal = await gw.waitOperationRun('bind-asset-run-1');
    expect(terminal.ok).toBe(true);
    if (terminal.ok) {
      expect(['succeeded', 'failed']).toContain(terminal.value.status);
      expect((terminal.value.input as { requestId?: string }).requestId).toBe('bind-asset-run-1');
      expect((terminal.value.input as { guids?: string[] }).guids).toEqual(['019f56f2-0ac0-776a-9d28-50eaf795daed']);
      expect((terminal.value.input as { slot?: number }).slot).toBe(0);
      if (terminal.value.status === 'failed') {
        expect(['ASSET_NOT_FOUND', 'asset-bind-failed']).toContain(terminal.value.error?.code ?? '');
      }
    }
  });
});
