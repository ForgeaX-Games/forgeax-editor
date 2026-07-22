// viewport-camera-appliers — the 5 camera session-op registrations extracted
// from viewport.ts (M8).
//
// Session-op appliers vs the per-frame facade write:
// The mid-frame orbit/fly writes stay on the direct facade path (applyCamera /
// flyTick) — out of the ledger (OOS-4). A gesture END dispatches ONE session op
// (cameraOrbit / cameraFly) whose applier re-writes the same pose but as a
// ledger-recorded record so collaborators (human/AI) see "the camera turned to
// X". Two extra kinds are AI-first (cameraTeleport / cameraLookAt) — no human
// gesture ever produces them, but they exist so an AI can specify pose without
// knowing the yaw/pitch math (cameraLookAt derives yaw/pitch from a look-at
// point using the engine convention forward = qCam·[0,0,-1] with qCam =
// yaw·Y × pitch·X).
//
// Session domain (registerSessionApplier): ledger +1, NO undo entry, does not
// occupy the _activeOp lifecycle slot (so orbit-while-dragging-a-gizmo cannot
// implicitly cancel a document begin — D-12 slot-safety).
//
// M4 (w19): the camera lives in the editorWorld, so writes go through the
// injected `editorEngine` (editorWorld facade) — NOT ctx.engine (which binds
// to the sceneWorld). ctx.engine would move a nonexistent sceneWorld entity
// and silently no-op. editorEngine still records trace leaves onto the active
// span (facade._recordLeaf reads the ambient active span, not a per-world
// binding), so ledger/trace semantics are preserved.

import { Transform } from '@forgeax/engine-runtime';
import type { EntityHandle } from '@forgeax/engine-ecs';
import type { EngineFacade } from '@forgeax/editor-core';
import { registerSessionApplier } from '@forgeax/editor-core';
import type { Vec3 } from './viewport-ray';
import { clampPitch, computeFlyCamera, computeOrbitCamera, flyToOrbit } from './viewport-camera';

/** The camera pose the appliers read and write back into the caller (viewport). */
export interface CameraPose {
  target: Vec3;
  yaw: number;
  pitch: number;
  dist: number;
  camPos: Vec3;
  fwd: Vec3;
  rgt: Vec3;
  upv: Vec3;
}

export interface CameraAppliersDeps {
  editorEngine: EngineFacade;
  camera: EntityHandle;
  /** Read the current pose (caller owns the storage). */
  getPose(): CameraPose;
  /** Write the new pose back into caller storage after each applier runs. */
  setPose(pose: CameraPose): void;
  /** requestFrame delegates to the closure-local frameSelection(). */
  frameSelection(): void;
}

/** Register all 5 camera session-op appliers. Returns a dispose fn that
 *  unregisters them in reverse order. */
export function registerCameraAppliers({
  editorEngine, camera, getPose, setPose, frameSelection,
}: CameraAppliersDeps): () => void {
  const writeCameraTransform = (r: { camPos: Vec3; qCam: number[] }): void => {
    editorEngine.set(camera, Transform, {
      pos: [r.camPos[0], r.camPos[1], r.camPos[2]],
      quat: [r.qCam[0]!, r.qCam[1]!, r.qCam[2]!, r.qCam[3]!],
      scale: [1, 1, 1],
    });
  };

  // ── cameraOrbit (D-12 path A, S13 / AC-30) ────────────────────────────────
  // The orbit gesture END (onUp) single-dispatches ONE cameraOrbit session op
  // carrying the gesture-end pose. When an AI issues cameraOrbit over eval
  // there is NO per-frame facade write, so this applier is the ONLY path that
  // actually moves the camera. T6b: an optional `pos` payload lets a caller
  // express "put camera here + look this way" without knowing the target math
  // (target = pos + fwd * dist).
  const unregOrbit = registerSessionApplier(
    'cameraOrbit',
    (op, _ctx): { ok: true } => {
      const o = op as unknown as {
        target?: [number, number, number]; yaw?: number; pitch?: number; dist?: number;
        pos?: [number, number, number];
      };
      const cur = getPose();
      const nextYaw = o.yaw ?? cur.yaw;
      const nextPitch = o.pitch ?? cur.pitch;
      const nextDist = o.dist ?? cur.dist;
      let tgt: Vec3;
      if (o.pos) {
        const flyR = computeFlyCamera({ pos: [o.pos[0], o.pos[1], o.pos[2]], yaw: nextYaw, pitch: nextPitch });
        tgt = [
          o.pos[0] + flyR.fwd[0] * nextDist,
          o.pos[1] + flyR.fwd[1] * nextDist,
          o.pos[2] + flyR.fwd[2] * nextDist,
        ];
      } else {
        tgt = o.target ? [o.target[0], o.target[1], o.target[2]] : [...cur.target];
      }
      const r = computeOrbitCamera(tgt, nextYaw, nextPitch, nextDist);
      writeCameraTransform(r);
      setPose({
        target: tgt, yaw: nextYaw, pitch: nextPitch, dist: nextDist,
        camPos: r.camPos, fwd: r.fwd, rgt: r.rgt, upv: r.upv,
      });
      return { ok: true };
    },
    { title: 'Orbit camera' },
  );

  // ── cameraFly (T4a) ───────────────────────────────────────────────────────
  // The FLY gesture end dispatches ONE cameraFly session op carrying
  // {pos, yaw, pitch}. Also reconstructs a reasonable orbit target so a
  // subsequent MMB/Alt+LMB gesture builds on the fly-end pose smoothly (T6a).
  const applyFlyLike = (op: unknown): void => {
    const o = op as { pos?: [number, number, number]; yaw?: number; pitch?: number };
    const cur = getPose();
    const p: Vec3 = o.pos ? [o.pos[0], o.pos[1], o.pos[2]] : [...cur.camPos];
    const nextYaw = o.yaw ?? cur.yaw;
    const nextPitch = o.pitch ?? cur.pitch;
    const r = computeFlyCamera({ pos: p, yaw: nextYaw, pitch: nextPitch });
    writeCameraTransform(r);
    const orb = flyToOrbit({ pos: p, yaw: nextYaw, pitch: nextPitch }, cur.dist);
    setPose({
      target: orb.target, yaw: nextYaw, pitch: nextPitch, dist: orb.dist,
      camPos: r.camPos, fwd: r.fwd, rgt: r.rgt, upv: r.upv,
    });
  };
  const unregFly = registerSessionApplier(
    'cameraFly',
    (op, _ctx): { ok: true } => { applyFlyLike(op); return { ok: true }; },
    { title: 'Fly camera to position' },
  );

  // ── cameraTeleport (T4b) ──────────────────────────────────────────────────
  // AI-first absolute pose teleport. Semantically same as cameraFly but named
  // "teleport" because there is no human gesture — AI just says "camera goes
  // here now". Separate kind for ledger/self-introspection.
  const unregTeleport = registerSessionApplier(
    'cameraTeleport',
    (op, _ctx): { ok: true } => { applyFlyLike(op); return { ok: true }; },
    { title: 'Teleport camera to position' },
  );

  // ── cameraLookAt (T4c) ────────────────────────────────────────────────────
  // AI-friendly: specify {pos, lookAt} instead of {pos, yaw, pitch}. yaw/pitch
  // are derived from the (pos → lookAt) vector using the engine convention:
  //   forward = qCam · [0,0,-1] with qCam = yaw·Y × pitch·X
  //   → yaw = atan2(-dx, -dz),  pitch = atan2(dy, hypot(dx,dz))
  const unregLookAt = registerSessionApplier(
    'cameraLookAt',
    (op, _ctx): { ok: true } => {
      const o = op as unknown as {
        pos?: [number, number, number]; lookAt?: [number, number, number];
      };
      if (!o.pos || !o.lookAt) return { ok: true };
      const dx = o.lookAt[0] - o.pos[0];
      const dy = o.lookAt[1] - o.pos[1];
      const dz = o.lookAt[2] - o.pos[2];
      const horiz = Math.hypot(dx, dz);
      const calcYaw = Math.atan2(-dx, -dz);
      const calcPitch = clampPitch(Math.atan2(dy, horiz));
      const p: Vec3 = [o.pos[0], o.pos[1], o.pos[2]];
      const r = computeFlyCamera({ pos: p, yaw: calcYaw, pitch: calcPitch });
      writeCameraTransform(r);
      const cur = getPose();
      const orb = flyToOrbit({ pos: p, yaw: calcYaw, pitch: calcPitch }, cur.dist);
      setPose({
        target: orb.target, yaw: calcYaw, pitch: calcPitch, dist: orb.dist,
        camPos: r.camPos, fwd: r.fwd, rgt: r.rgt, upv: r.upv,
      });
      return { ok: true };
    },
    { title: 'Move camera and look at target' },
  );

  // ── requestFrame — D-10 → edit-runtime migration ──────────────────────────
  // The "frame selection in viewport" pulse — delegates to the closure-local
  // frameSelection helper (which needs the gizmo pool + selection reads).
  // The em-dash form (name then '—', not name followed by '(') keeps this
  // comment out of the AC-03 sealed-setter grep assertion in
  // gateway-grep-assertions.test.ts.
  const unregRequestFrame = registerSessionApplier(
    'requestFrame',
    (_op, _ctx): { ok: true } => {
      frameSelection();
      return { ok: true };
    },
    { title: 'Frame selection in viewport' },
  );

  return () => {
    unregRequestFrame();
    unregLookAt();
    unregTeleport();
    unregFly();
    unregOrbit();
  };
}
