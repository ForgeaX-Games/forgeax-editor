// addSceneAssetToScene (session) op registration + validation contract.
//
// solo round-6 / skinning-pillar convergence: a scene sub-asset catalogued by GUID
// (e.g. just imported via the importAsset op) had NO front-door path into the live
// scene — the "Add to Scene" orchestration lived only in the UI closure
// (spawnGlbSceneAsMount), so an AI could NOT do what the human button does. This
// test pins the fix (registry razor — the capability is now AI-discoverable + AI-
// dispatchable), and would have FAILED before it (no op → hasOp false, dispatch →
// UNKNOWN_OP):
//   - addSceneAssetToScene is a SESSION-domain op, cataloged (AI-discoverable via
//     listOps), with sceneGuid + requestId as required args.
//   - dispatching it with a valid sceneGuid/requestId is accepted and returns the
//     independent OperationRun that carries the asynchronous mount outcome.
//   - dispatching it with a missing/empty sceneGuid fails fast with a STRUCTURED
//     error (INVALID_ARGS), never a silent no-op (charter P3 / Fail Fast).

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';
import { hasOp, getOp, listOps } from '../io/catalog';
// Importing the barrel loads spawn-asset-ref's side-effect (session applier
// registration), exactly as the app boot does.
import '../index';
import type { EditSession } from '../types';

describe('addSceneAssetToScene op registration (catalog SSOT)', () => {
  it('addSceneAssetToScene is a cataloged SESSION op (AI-discoverable)', () => {
    expect(hasOp('addSceneAssetToScene')).toBe(true);
    expect(getOp('addSceneAssetToScene')?.domain).toBe('session');
    const op = listOps().find((o) => o.id === 'addSceneAssetToScene');
    expect(op?.domain).toBe('session');
    // argsSchema drives AI self-discovery — both identity inputs are required.
    expect(op?.argsSchema?.required).toContain('sceneGuid');
    expect(op?.argsSchema?.required).toContain('requestId');
    expect(op?.operationRun?.read.wait).toBe('waitOperationRun');
    expect(op?.operationRun?.cancellable).toBe(false);
  });

  // solo round-10 (P6 animation): the argsSchema description is the machine-readable
  // contract an AI reads via listOps(). It previously CLAIMED the mount includes an
  // "AnimationPlayer" for skinned assets — false: the gltf cook never bakes one (clip
  // choice is authoring intent) and instantiation adds none, so a docs-following AI
  // queried {with:['Skin','AnimationPlayer']}, got [], and concluded the tool was
  // broken. This pins the corrected contract: the description must NOT promise an
  // AnimationPlayer, and must state the Skin/Skeleton truth. A regression that
  // re-adds the false claim (or drops the correction) fails here.
  it('sceneGuid description tells the truth: Skin/Skeleton mounted, AnimationPlayer NOT created', () => {
    const op = listOps().find((o) => o.id === 'addSceneAssetToScene');
    const desc = op?.argsSchema?.properties?.sceneGuid?.description ?? '';
    // Must NOT promise a playing/bound AnimationPlayer as part of the mount.
    expect(desc).not.toMatch(/incl[^.]*AnimationPlayer/i);
    // Must state the truthful rig contents + the explicit "does NOT create an AnimationPlayer".
    expect(desc).toMatch(/Skin/);
    expect(desc).toMatch(/does NOT create an AnimationPlayer/i);
  });
});

describe('addSceneAssetToScene dispatch (session applier)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    const session: EditSession = createEditSession();
    session.world = {} as never;
    gw = new EditGateway(session);
  });

  it('missing sceneGuid fails fast with a STRUCTURED error (not a silent no-op)', () => {
    // No sceneGuid → the applier must reject with INVALID_ARGS, never {ok:true}.
    const r = gw.dispatch({ kind: 'addSceneAssetToScene' } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
  });

  it('empty sceneGuid fails fast with a STRUCTURED error', () => {
    const r = gw.dispatch({ kind: 'addSceneAssetToScene', sceneGuid: '', requestId: 'scene-empty-guid' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
  });

  it('missing requestId fails validation before accepting an unobservable mount', () => {
    const r = gw.dispatch({ kind: 'addSceneAssetToScene', sceneGuid: 'scene-guid' } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
  });

  it('valid sceneGuid/requestId is accepted with a running OperationRun', () => {
    const r = gw.dispatch({
      kind: 'addSceneAssetToScene',
      sceneGuid: '019f5545-087e-7f92-9041-f5b839605afe',
      name: 'Fox',
      requestId: 'scene-mount-accepted',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result?.operationRun?.requestId).toBe('scene-mount-accepted');
      expect(r.result?.operationRun?.operationId).toBe('addSceneAssetToScene');
      expect(r.result?.operationRun?.status).toBe('running');
    }
  });
});

describe('addSceneAssetToScene async observability', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createEditSession());
  });

  it('keeps concurrent mount requests independent and publishes terminal facts by requestId', async () => {
    const first = gw.dispatch({
      kind: 'addSceneAssetToScene',
      sceneGuid: 'scene-guid-one',
      requestId: 'scene-mount-one',
    });
    const second = gw.dispatch({
      kind: 'addSceneAssetToScene',
      sceneGuid: 'scene-guid-two',
      requestId: 'scene-mount-two',
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const [one, two] = await Promise.all([
      gw.waitOperationRun('scene-mount-one'),
      gw.waitOperationRun('scene-mount-two'),
    ]);
    expect(one.ok).toBe(true);
    expect(two.ok).toBe(true);
    if (one.ok && two.ok) {
      expect(one.value.requestId).toBe('scene-mount-one');
      expect(two.value.requestId).toBe('scene-mount-two');
      expect(['succeeded', 'failed']).toContain(one.value.status);
      expect(['succeeded', 'failed']).toContain(two.value.status);
      if (one.value.status === 'failed') {
        expect(one.value.error?.code).toBe('scene-mount-failed');
        expect(one.value.error?.current).toMatchObject({ requestId: 'scene-mount-one', sceneGuid: 'scene-guid-one' });
        expect((one.value.error?.current as { cleanup?: { attempted?: boolean } })?.cleanup?.attempted).toBeTypeOf('boolean');
      }
      if (two.value.status === 'failed') {
        expect(two.value.error?.code).toBe('scene-mount-failed');
        expect(two.value.error?.current).toMatchObject({ requestId: 'scene-mount-two', sceneGuid: 'scene-guid-two' });
        expect((two.value.error?.current as { cleanup?: { attempted?: boolean } })?.cleanup?.attempted).toBeTypeOf('boolean');
      }
      expect((one.value.input as { requestId?: string }).requestId).toBe('scene-mount-one');
      expect((two.value.input as { requestId?: string }).requestId).toBe('scene-mount-two');
    }
  });
});
