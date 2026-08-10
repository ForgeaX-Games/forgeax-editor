// viewport-camera-appliers — camera session-op registrations extracted
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
//
// Building the op bodies (createCameraOps) is separate from claiming the global
// op kinds (registerCameraAppliers) because an op kind lives in exactly ONE
// domain process-wide: a second registration is an OP_ID_CONFLICT throw. The
// scene viewport owns the ledger-visible camera kinds; a secondary viewport
// (the MI preview's private orbit camera — chrome, never authored state) runs
// the same bodies against its own table without registering them.

import { Transform } from '@forgeax/engine-scene';
import type { EntityHandle } from '@forgeax/engine-ecs';
import type { EngineFacade, SessionApplierMeta } from '@forgeax/editor-core';
import { registerSessionApplier } from '@forgeax/editor-core';
import type { Vec3 } from './viewport-ray';
import {
  adjustFov,
  adjustOrthoHalfHeight,
  clampDist,
  clampFov,
  clampOrthoHalfHeight,
  clampPitch,
  clampPitchForProjection,
  computeFlyCamera,
  computeOrbitCamera,
  deriveOrthoHalfHeight,
  flyToOrbit,
  viewPresetOrientation,
  type CameraProjection,
  type CameraViewPreset,
} from './viewport-camera';

const invalidArgs = (hint: string) => ({
  ok: false as const,
  error: { code: 'INVALID_ARGS' as const, hint },
});

function isFiniteVec3(value: unknown): value is [number, number, number] {
  return Array.isArray(value)
    && value.length === 3
    && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

interface NormalizedFlyInput {
  readonly ok: true;
  readonly pos: Vec3;
  readonly yaw: number;
  readonly pitch: number;
}

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
  projection: CameraProjection;
  fov: number;
  orthoHalfHeight: number;
}

export type CameraBookmark = CameraPose;

export interface CameraAppliersDeps {
  editorEngine: EngineFacade;
  camera: EntityHandle;
  /** Read the current pose (caller owns the storage). */
  getPose(): CameraPose;
  /** Write the new pose back into caller storage after each applier runs. */
  setPose(pose: CameraPose): void;
  /** Repaint the editor camera, projection and visual helpers from caller state. */
  applyCamera(): void;
  /** Abort an in-progress pointer gesture (fly/orbit/pan) before an op whose
   *  semantics conflict with it — e.g. cameraSetView switching to orthographic
   *  while RMB-fly is live would leave flyTick writing a forbidden ortho fly.
   *  Optional: the orbit-only preview viewport has no gesture loop to cancel. */
  cancelNavigation?(): void;
  getBookmark(slot: number): CameraBookmark | undefined;
  setBookmark(slot: number, bookmark: CameraBookmark | null): void;
  /** requestFrame delegates to the closure-local frameSelection(). */
  frameSelection(): void;
}

export type CameraOpResult = { ok: true } | ReturnType<typeof invalidArgs>;

/** One camera op body plus its catalog metadata, built but not yet registered. */
export interface CameraOp {
  readonly kind: string;
  readonly apply: (op: unknown) => CameraOpResult;
  readonly meta: SessionApplierMeta;
}

export interface CameraOps {
  readonly entries: readonly CameraOp[];
  /** Run one op against this table only — no ledger entry, no global registry. */
  run(op: { kind: string }): CameraOpResult | undefined;
}

/** Build the camera op bodies bound to one viewport's pose storage. */
export function createCameraOps({
  editorEngine, camera, getPose, setPose, applyCamera, cancelNavigation, getBookmark, setBookmark, frameSelection,
}: CameraAppliersDeps): CameraOps {
  const entries: CameraOp[] = [];
  const define = (kind: string, apply: (op: unknown) => CameraOpResult, meta: SessionApplierMeta): void => {
    entries.push({ kind, apply, meta });
  };

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
  define(
    'cameraOrbit',
    (op): CameraOpResult => {
      const o = op as unknown as {
        target?: [number, number, number]; yaw?: number; pitch?: number; dist?: number;
        pos?: [number, number, number];
      };
      const cur = getPose();
      if (o.target !== undefined && !isFiniteVec3(o.target)) return invalidArgs('target must be a finite [x,y,z] array');
      if (o.pos !== undefined && !isFiniteVec3(o.pos)) return invalidArgs('pos must be a finite [x,y,z] array');
      if (o.yaw !== undefined && !isFiniteNumber(o.yaw)) return invalidArgs('yaw must be a finite number');
      if (o.pitch !== undefined && !isFiniteNumber(o.pitch)) return invalidArgs('pitch must be a finite number');
      if (o.dist !== undefined && !isFiniteNumber(o.dist)) return invalidArgs('dist must be a finite number');
      const nextYaw = o.yaw ?? cur.yaw;
      // Projection-aware pitch clamp (R1): an orthographic axis view sits at
      // exactly ±90°; clamping to the perspective ±86° here would snap the
      // view on every pan/zoom gesture-end (those ride this same op).
      const nextPitch = clampPitchForProjection(o.pitch ?? cur.pitch, cur.projection);
      const nextDist = clampDist(o.dist ?? cur.dist);
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
      setPose({
        target: tgt, yaw: nextYaw, pitch: nextPitch, dist: nextDist,
        camPos: r.camPos, fwd: r.fwd, rgt: r.rgt, upv: r.upv,
        projection: cur.projection, fov: cur.fov, orthoHalfHeight: cur.orthoHalfHeight,
      });
      applyCamera();
      return { ok: true };
    },
    { title: 'Orbit camera' },
  );

  // ── cameraFly (T4a) ───────────────────────────────────────────────────────
  // The FLY gesture end dispatches ONE cameraFly session op carrying
  // {pos, yaw, pitch}. Also reconstructs a reasonable orbit target so a
  // subsequent MMB/Alt+LMB gesture builds on the fly-end pose smoothly (T6a).
  const normalizeFlyInput = (op: unknown, cur: CameraPose): NormalizedFlyInput | ReturnType<typeof invalidArgs> => {
    const o = op as { pos?: [number, number, number]; yaw?: number; pitch?: number };
    if (o.pos !== undefined && !isFiniteVec3(o.pos)) return invalidArgs('pos must be a finite [x,y,z] array');
    if (o.yaw !== undefined && !isFiniteNumber(o.yaw)) return invalidArgs('yaw must be a finite number');
    if (o.pitch !== undefined && !isFiniteNumber(o.pitch)) return invalidArgs('pitch must be a finite number');
    const p: Vec3 = o.pos ? [o.pos[0], o.pos[1], o.pos[2]] : [...cur.camPos];
    const nextYaw = o.yaw ?? cur.yaw;
    const nextPitch = clampPitchForProjection(o.pitch ?? cur.pitch, cur.projection);
    return { ok: true, pos: p, yaw: nextYaw, pitch: nextPitch };
  };
  const applyFlyLike = (op: unknown): { ok: true } | ReturnType<typeof invalidArgs> => {
    const cur = getPose();
    const normalized = normalizeFlyInput(op, cur);
    if (!normalized.ok) return normalized;
    const p = normalized.pos;
    const nextYaw = normalized.yaw;
    const nextPitch = normalized.pitch;
    const r = computeFlyCamera({ pos: p, yaw: nextYaw, pitch: nextPitch });
    const orb = flyToOrbit({ pos: p, yaw: nextYaw, pitch: nextPitch }, cur.dist);
    setPose({
      target: orb.target, yaw: nextYaw, pitch: nextPitch, dist: orb.dist,
      camPos: r.camPos, fwd: r.fwd, rgt: r.rgt, upv: r.upv,
      projection: cur.projection, fov: cur.fov, orthoHalfHeight: cur.orthoHalfHeight,
    });
    applyCamera();
    return { ok: true };
  };
  define(
    'cameraFly',
    (op) => applyFlyLike(op),
    { title: 'Fly camera to position' },
  );

  // ── cameraTeleport (T4b) ──────────────────────────────────────────────────
  // AI-first absolute pose teleport. Semantically same as cameraFly but named
  // "teleport" because there is no human gesture — AI just says "camera goes
  // here now". Separate kind for ledger/self-introspection.
  define(
    'cameraTeleport',
    (op) => applyFlyLike(op),
    { title: 'Teleport camera to position' },
  );

  // ── cameraLookAt (T4c) ────────────────────────────────────────────────────
  // AI-friendly: specify {pos, lookAt} instead of {pos, yaw, pitch}. yaw/pitch
  // are derived from the (pos → lookAt) vector using the engine convention:
  //   forward = qCam · [0,0,-1] with qCam = yaw·Y × pitch·X
  //   → yaw = atan2(-dx, -dz),  pitch = atan2(dy, hypot(dx,dz))
  define(
    'cameraLookAt',
    (op): CameraOpResult => {
      const o = op as unknown as {
        pos?: [number, number, number]; lookAt?: [number, number, number];
      };
      if (!isFiniteVec3(o.pos)) return invalidArgs('pos must be a finite [x,y,z] array');
      if (!isFiniteVec3(o.lookAt)) return invalidArgs('lookAt must be a finite [x,y,z] array');
      const dx = o.lookAt[0] - o.pos[0];
      const dy = o.lookAt[1] - o.pos[1];
      const dz = o.lookAt[2] - o.pos[2];
      const horiz = Math.hypot(dx, dz);
      if (Math.hypot(dx, dy, dz) <= Number.EPSILON) return invalidArgs('lookAt must differ from pos');
      const cur = getPose();
      const calcYaw = Math.atan2(-dx, -dz);
      const calcPitch = clampPitchForProjection(Math.atan2(dy, horiz), cur.projection);
      const p: Vec3 = [o.pos[0], o.pos[1], o.pos[2]];
      const r = computeFlyCamera({ pos: p, yaw: calcYaw, pitch: calcPitch });
      const orb = flyToOrbit({ pos: p, yaw: calcYaw, pitch: calcPitch }, cur.dist);
      setPose({
        target: orb.target, yaw: calcYaw, pitch: calcPitch, dist: orb.dist,
        camPos: r.camPos, fwd: r.fwd, rgt: r.rgt, upv: r.upv,
        projection: cur.projection, fov: cur.fov, orthoHalfHeight: cur.orthoHalfHeight,
      });
      applyCamera();
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
  define(
    'requestFrame',
    (): CameraOpResult => {
      frameSelection();
      return { ok: true };
    },
    { title: 'Frame selection in viewport' },
  );

  define(
    'cameraSetProjection',
    (op): CameraOpResult => {
      const value = (op as { projection?: unknown }).projection;
      if (value !== 'perspective' && value !== 'orthographic') {
        return invalidArgs('projection must be "perspective" or "orthographic"');
      }
      const cur = getPose();
      setPose({ ...cur, projection: value });
      applyCamera();
      return { ok: true };
    },
    {
      title: 'Set camera projection',
      argsSchema: {
        type: 'object',
        properties: { projection: { type: 'string', enum: ['perspective', 'orthographic'] } },
        required: ['projection'],
      },
    },
  );

  define(
    'cameraToggleProjection',
    (): CameraOpResult => {
      const cur = getPose();
      setPose({ ...cur, projection: cur.projection === 'perspective' ? 'orthographic' : 'perspective' });
      applyCamera();
      return { ok: true };
    },
    { title: 'Toggle camera projection' },
  );

  // ── cameraSetView (UE-style view presets) ─────────────────────────────────
  // One op expresses the composite "view" semantic: projection + axis-aligned
  // orientation. Axis views → orthographic with the preset yaw/pitch (kept at
  // exactly ±90° for top/bottom — the applier must NOT route these through the
  // perspective pitch clamp); the orbit target stays so the view keeps looking
  // at the same scene content, and the ortho view scale carries over (derived
  // from dist/fov when coming from perspective). 'perspective' restores the
  // perspective projection keeping the view direction, with a ONE-TIME pitch
  // clamp back into the perspective gesture range so the next orbit gesture
  // doesn't snap (R5).
  define(
    'cameraSetView',
    (op): CameraOpResult => {
      const view = (op as { view?: unknown }).view;
      if (view !== 'perspective' && view !== 'top' && view !== 'bottom'
        && view !== 'left' && view !== 'right' && view !== 'front' && view !== 'back') {
        return invalidArgs('view must be one of perspective|top|bottom|left|right|front|back');
      }
      // Switching projection mid-fly would leave flyTick writing an ortho fly
      // (forbidden) — end any live pointer gesture first.
      cancelNavigation?.();
      const cur = getPose();
      if (view === 'perspective') {
        const pitch = clampPitch(cur.pitch);
        const r = computeOrbitCamera(cur.target, cur.yaw, pitch, cur.dist);
        setPose({
          ...cur, pitch,
          camPos: r.camPos, fwd: r.fwd, rgt: r.rgt, upv: r.upv,
          projection: 'perspective',
        });
        applyCamera();
        return { ok: true };
      }
      const orientation = viewPresetOrientation(view as CameraViewPreset);
      if (!orientation) return invalidArgs(`no orientation for view "${view}"`);
      const orthoHalfHeight = cur.projection === 'orthographic'
        ? clampOrthoHalfHeight(cur.orthoHalfHeight)
        : deriveOrthoHalfHeight(cur.dist, cur.fov);
      const r = computeOrbitCamera(cur.target, orientation.yaw, orientation.pitch, cur.dist);
      setPose({
        ...cur,
        yaw: orientation.yaw,
        pitch: orientation.pitch,
        camPos: r.camPos, fwd: r.fwd, rgt: r.rgt, upv: r.upv,
        projection: 'orthographic',
        orthoHalfHeight,
      });
      applyCamera();
      return { ok: true };
    },
    {
      title: 'Set viewport view preset',
      argsSchema: {
        type: 'object',
        properties: {
          view: {
            type: 'string',
            enum: ['perspective', 'top', 'bottom', 'left', 'right', 'front', 'back'],
          },
        },
        required: ['view'],
      },
    },
  );

  define(
    'cameraAdjustFov',
    (op): CameraOpResult => {
      const delta = (op as { delta?: unknown }).delta;
      if (typeof delta !== 'number' || !Number.isFinite(delta) || delta === 0) {
        return invalidArgs('delta must be a non-zero finite number');
      }
      const cur = getPose();
      setPose({
        ...cur,
        fov: cur.projection === 'perspective' ? adjustFov(cur.fov, delta) : cur.fov,
        orthoHalfHeight: cur.projection === 'orthographic'
          ? adjustOrthoHalfHeight(cur.orthoHalfHeight, delta)
          : cur.orthoHalfHeight,
      });
      applyCamera();
      return { ok: true };
    },
    {
      title: 'Adjust camera view scale',
      argsSchema: {
        type: 'object',
        properties: { delta: { type: 'number' } },
        required: ['delta'],
      },
    },
  );

  define(
    'cameraZoom',
    (op): CameraOpResult => {
      const delta = (op as { delta?: unknown }).delta;
      if (typeof delta !== 'number' || !Number.isFinite(delta) || delta === 0) {
        return invalidArgs('delta must be a non-zero finite number');
      }
      const cur = getPose();
      setPose({
        ...cur,
        dist: cur.projection === 'perspective'
          ? clampDist(cur.dist * (delta > 0 ? 0.9 : delta < 0 ? 1.1 : 1))
          : cur.dist,
        orthoHalfHeight: cur.projection === 'orthographic'
          ? adjustOrthoHalfHeight(cur.orthoHalfHeight, delta)
          : cur.orthoHalfHeight,
      });
      applyCamera();
      return { ok: true };
    },
    {
      title: 'Zoom camera',
      argsSchema: {
        type: 'object',
        properties: { delta: { type: 'number' } },
        required: ['delta'],
      },
    },
  );

  define(
    'cameraBookmark',
    (op): CameraOpResult => {
      const input = op as { action?: unknown; slot?: unknown };
      if (input.action !== 'save' && input.action !== 'recall' && input.action !== 'clear') {
        return invalidArgs('action must be "save", "recall", or "clear"');
      }
      if (typeof input.slot !== 'number' || !Number.isInteger(input.slot) || input.slot < 1 || input.slot > 9) {
        return invalidArgs('slot must be an integer between 1 and 9');
      }
      const slot = input.slot;
      if (input.action === 'save') {
        const cur = getPose();
        setBookmark(slot, {
          ...cur,
          target: [...cur.target],
          camPos: [...cur.camPos],
          fwd: [...cur.fwd],
          rgt: [...cur.rgt],
          upv: [...cur.upv],
        });
        return { ok: true };
      }
      if (input.action === 'clear') {
        setBookmark(slot, null);
        return { ok: true };
      }
      const bookmark = getBookmark(slot);
      if (!bookmark) return invalidArgs(`camera bookmark ${slot} is empty`);
      setPose({
        ...bookmark,
        target: [...bookmark.target],
        // Orthographic bookmarks may legitimately hold ±90° (Top/Bottom views).
        pitch: clampPitchForProjection(bookmark.pitch, bookmark.projection),
        dist: clampDist(bookmark.dist),
        camPos: [...bookmark.camPos],
        fwd: [...bookmark.fwd],
        rgt: [...bookmark.rgt],
        upv: [...bookmark.upv],
        fov: clampFov(bookmark.fov),
        orthoHalfHeight: clampOrthoHalfHeight(bookmark.orthoHalfHeight),
      });
      applyCamera();
      return { ok: true };
    },
    {
      title: 'Camera bookmark',
      argsSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['save', 'recall', 'clear'] },
          slot: { type: 'number', minimum: 1, maximum: 9 },
        },
        required: ['action', 'slot'],
      },
    },
  );

  return {
    entries,
    run: (op) => entries.find((entry) => entry.kind === op.kind)?.apply(op),
  };
}

/** Claim the camera op kinds as session ops (ledger +1, no undo). Only the
 *  scene viewport may do this — the kinds are process-global. Returns a dispose
 *  fn that unregisters them in reverse order. */
export function registerCameraAppliers(ops: CameraOps): () => void {
  const unregisters = ops.entries.map(
    (entry) => registerSessionApplier(entry.kind, (op) => entry.apply(op), entry.meta),
  );
  return () => {
    for (let i = unregisters.length - 1; i >= 0; i--) unregisters[i]!();
  };
}
