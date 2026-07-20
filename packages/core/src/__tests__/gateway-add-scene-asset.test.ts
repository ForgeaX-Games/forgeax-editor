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
//     listOps), with sceneGuid as the one required arg.
//   - dispatching it with a valid sceneGuid is accepted (fire-and-forget session
//     applier — the mount completes in a detached promise).
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
    // argsSchema drives AI self-discovery — sceneGuid is the one required field.
    expect(op?.argsSchema?.required).toContain('sceneGuid');
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
    const r = gw.dispatch({ kind: 'addSceneAssetToScene', sceneGuid: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
  });

  it('valid sceneGuid is accepted (fire-and-forget; mount runs detached)', () => {
    // The applier returns synchronously {ok:true}; the async spawnGlbSceneAsMount
    // body runs in a detached promise (it will no-op here — no live world/registry
    // — and warn, which is the intended fire-and-forget contract, not a throw).
    const r = gw.dispatch({
      kind: 'addSceneAssetToScene',
      sceneGuid: '019f5545-087e-7f92-9041-f5b839605afe',
      name: 'Fox',
    });
    expect(r.ok).toBe(true);
  });
});

describe('addSceneAssetToScene async observability', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createEditSession());
  });

  it('publishes pending → mounted without inventing a second operation path', () => {
    expect(gw.sceneMountPhase).toBe('idle');
    expect(gw.lastSceneMountError).toBeNull();

    gw.beginSceneMountAttempt();
    expect(gw.sceneMountPhase).toBe('pending');
    expect(gw.lastSceneMountError).toBeNull();

    gw.completeSceneMountAttempt();
    expect(gw.sceneMountPhase).toBe('mounted');
    expect(gw.lastSceneMountError).toBeNull();
  });

  it('publishes a structured terminal mount failure that a caller can branch on', () => {
    gw.beginSceneMountAttempt();
    gw.failSceneMountAttempt({
      code: 'scene-mount-failed',
      hint: 'could not load scene asset guid',
    });

    expect(gw.sceneMountPhase).toBe('failed');
    expect(gw.lastSceneMountError).toEqual({
      code: 'scene-mount-failed',
      hint: 'could not load scene asset guid',
    });

    // A retry resets the old terminal state before the next asynchronous result.
    gw.beginSceneMountAttempt();
    expect(gw.sceneMountPhase).toBe('pending');
    expect(gw.lastSceneMountError).toBeNull();
  });
});
