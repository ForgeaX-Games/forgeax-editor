// Viewport interaction — the "human directly manipulates the scene" half of Edit
// mode (design EDITOR-MODE P1: viewport navigation / picking / gizmo). The forgeax port shipped
// only the data model + Hierarchy + Inspector + doc→world render, leaving the
// canvas inert; this module adds:
//   • camera navigation — UE5 EDITOR STYLE (feedback 2026-07-16):
//                      RMB (hold)     = FLY MODE (free-look + WASD/QE + scroll speed)
//                      MMB drag       = pan (no modifier needed)
//                      Alt + LMB      = orbit (tumble around target)
//                      Alt + RMB      = zoom / dolly
//                      scroll wheel   = zoom (outside fly) / speed adj (inside fly)
//                      LMB            = select / gizmo (reserved, unchanged)
//   • click-to-pick  — left-click an entity → select it (ray vs per-entity AABB);
//                      left-click empty = deselect
//   • drag-to-move   — left-drag a selected entity → slide it on the ground (XZ);
//                      hold Shift → move vertically (Y). Live via world.set (no
//                      doc churn), committed as ONE undoable setComponent on release.
//
// Camera math reuses fps's PROVEN engine convention: qCam = yaw·[0,1,0] × pitch·
// [1,0,0]; forward = qCam·[0,0,-1]. Pure geometry (ray/AABB/plane) is factored out
// + unit-tested; only the wiring depends on the (untyped) engine.
import {
  Transform,
  ChildOf,
  MeshFilter,
  MeshRenderer,
  Camera,
  perspective,
  TONEMAP_REINHARD_EXTENDED,
  quat,
  Materials,
} from '@forgeax/engine-runtime';
// engine #650 (Tier-2 decomposition) moved builtin handles + AssetRegistry into
// @forgeax/engine-assets-runtime, and pick/PickError into @forgeax/engine-picking.
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { pick as enginePick, PickError } from '@forgeax/engine-picking';
import type { World, EntityHandle, Handle } from '@forgeax/engine-ecs';
// engine #610 (Tier-1 decomposition) moved procedural mesh builders into the
// @forgeax/engine-geometry leaf package.
import { meshFromInterleaved } from '@forgeax/engine-geometry';

// M2 extraction: pure geometry lives in viewport-ray.ts; orbit math in viewport-camera.ts.
// M6 extraction (plan-strategy §2 D-5, AC-08): pure gizmo + param-gizmo geometry
// (axis/plane/ring constants, cone mesh data, light/camera wireframe point sets)
// lives in viewport-gizmo-geometry.ts. viewport.ts is now a DI factory
// (createViewport) + re-export barrel — the engine wiring + interaction state
// machine stay here; all pure math is imported from the three sibling modules.
export { type Vec3, num, ndcFromClient, rayDirection, rayAABB, rayPlaneY, closestAxisT, rayPlane, orthoBasis, angleOnAxis, entityBox } from './viewport-ray';
export { deriveInputTarget, clampPitch, clampDist, advanceOrbit, computeOrbitCamera, clampFlySpeed, applyFlyWheelSpeed, advanceFly, advanceFlyLook, computeFlyCamera, orbitToFly, flyToOrbit, FLY_SPEED_DEFAULT, FLY_SPEED_MIN, FLY_SPEED_MAX, FLY_SPEED_STEP, type RunMode, type DisplayMode, type InputTarget, type ControlOwner, type OrbitState, type OrbitCameraResult, type FlyState, type FlyInput, type Quat } from './viewport-camera';
import { type Vec3, num, ndcFromClient, rayDirection, rayAABB, rayPlaneY, closestAxisT, rayPlane, orthoBasis, angleOnAxis, entityBox } from './viewport-ray';
import { clampDist, clampPitch, advanceOrbit, computeOrbitCamera, advanceFly, advanceFlyLook, computeFlyCamera, applyFlyWheelSpeed, flyToOrbit, FLY_SPEED_DEFAULT, type InputTarget, type FlyInput } from './viewport-camera';
import { worldPointToParentLocal } from './viewport-transform';
import {
  DEG2RAD, AXES, PLANES, RING_SEG, TIP_QUAT, type PlaneHandle,
  buildConeMeshData, lightGizmoPoints, cameraGizmoPoints,
} from './viewport-gizmo-geometry';

import type { OpHandle, EngineFacade } from '@forgeax/editor-core';
import { worldEntityHandles, entExists, entComponent, entComponents, quatToEuler } from '@forgeax/editor-core';
// M3 (AC-03, plan-strategy §2 D-9): selection / field-preview / gizmo-mode go
// through the one gateway door — gateway.dispatch({ kind, … }) — and the gizmo DRAG
// (a document continuous op) uses the gateway lifecycle begin/update*/commit so
// the whole multi-frame drag lands as ONE undoable command. Direct store setters
// (setSelection/setFieldPreview/setGizmoMode) are gone. Camera orbit stays a
// direct world.set (see the note at applyCamera).
import { gateway, getGizmoMode, getSelection, onGizmoModeChange, onSelectionChange, registerSessionApplier } from '@forgeax/editor-core';
// M4: EngineSync import removed — sync.ts deleted (projection layer collapse).
import { isAuxVisible, onDisplayModeChange } from './display-bus';

// ── M7-a (AC-15): doc.entities mirror deleted — gizmo/pick read the WORLD ──────
// The dual-write mirror (EntityNode.components) is gone; the world is the SSOT.
// entComponent(session, id, 'Transform') returns the engine-native POD
// (pos[3] + quat[4] + scale[3] + world[16] arrays — feat-20260709 array-TRS).
// The viewport gizmo/drag math is written against the editor euler-degree shape
// (x/y/z + rotX/rotY/rotZ), so read once through these adapters and convert
// quat→euler HERE (euler-quat.ts is the SSOT for that conversion — AGENTS.md #6).
// Returns undefined for organizational nodes (no Transform) so callers keep their
// "nothing to gizmo/pick" fast-exit.
//
// Two variants — LOCAL vs WORLD — because the same entity means different things
// to different subsystems:
//   LOCAL  (pos/quat/scale) → drag write-back (gateway.dispatch writes engine pos)
//   WORLD  (world matrix)   → gizmo display / pick AABB / frame-selection orbit
// For a root entity local == world; for a bone deep in a skeleton hierarchy they
// differ by tens of units, and mixing them puts the gizmo at the wrong position.
type EditorTransform = {
  x: number; y: number; z: number;
  rotX: number; rotY: number; rotZ: number;
  scaleX: number; scaleY: number; scaleZ: number;
};
// Index a stored engine array<f32,N> column value (number[] | Float32Array),
// falling back to `d` for a missing / non-finite axis.
function ax(arr: unknown, i: number, d: number): number {
  const v = (arr as ArrayLike<number> | undefined)?.[i];
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
/** Read the entity's LOCAL Transform (pos/quat/scale as stored in the engine).
 *  The drag system writes BACK to engine `pos`, so it needs the local shape. */
function readLocalTransform(world: World, handle: EntityHandle): EditorTransform | undefined {
  const r = entComponent(world, handle, 'Transform');
  if (!r.ok) return undefined;
  const t = r.value as Record<string, unknown>;
  const e = quatToEuler(ax(t.quat, 0, 0), ax(t.quat, 1, 0), ax(t.quat, 2, 0), ax(t.quat, 3, 1));
  return {
    x: ax(t.pos, 0, 0), y: ax(t.pos, 1, 0), z: ax(t.pos, 2, 0),
    rotX: e.rotX, rotY: e.rotY, rotZ: e.rotZ,
    scaleX: ax(t.scale, 0, 1), scaleY: ax(t.scale, 1, 1), scaleZ: ax(t.scale, 2, 1),
  };
}
/** Read the entity's WORLD-space Transform (translation from the computed world
 *  matrix column-major [12..14]; rotation + scale stay local for now — extracting
 *  world rotation from the matrix is non-trivial and the callers that use rot/scale
 *  (param-gizmo, entityBox) operate on root entities where local == world). */
function readWorldTransform(world: World, handle: EntityHandle): EditorTransform | undefined {
  const r = entComponent(world, handle, 'Transform');
  if (!r.ok) return undefined;
  const t = r.value as Record<string, unknown>;
  const w = t.world as ArrayLike<number> | undefined;
  // Fall back to local if world matrix is missing (shouldn't happen, but be safe).
  if (!w || w.length < 16) return readLocalTransform(world, handle);
  const e = quatToEuler(ax(t.quat, 0, 0), ax(t.quat, 1, 0), ax(t.quat, 2, 0), ax(t.quat, 3, 1));
  return {
    x: ax(w, 12, 0), y: ax(w, 13, 0), z: ax(w, 14, 0),
    rotX: e.rotX, rotY: e.rotY, rotZ: e.rotZ,
    scaleX: ax(t.scale, 0, 1), scaleY: ax(t.scale, 1, 1), scaleZ: ax(t.scale, 2, 1),
  };
}
/** Convert an absolute world-space target to the local `Transform.pos` stored
 *  on `handle`. Transform propagation defines `child.world = parent.world ×
 *  child.local`, so the only correct inverse for a parented entity is
 *  `inverse(parent.world) × target` — using the child's normalized world axes
 *  loses inherited scale and incorrectly folds in the child's own rotation. */
function worldPositionToLocal(world: World, handle: EntityHandle, target: Vec3): Vec3 {
  const childOf = entComponent(world, handle, 'ChildOf');
  if (!childOf.ok) return target;
  const parent = childOf.value.parent as number | undefined;
  if (parent === undefined) return target;
  const parentTransform = entComponent(world, parent as EntityHandle, 'Transform');
  if (!parentTransform.ok) return target;
  const parentWorld = parentTransform.value.world as ArrayLike<number> | undefined;
  if (!parentWorld || parentWorld.length < 16) return target;
  return worldPointToParentLocal(parentWorld, target);
}
// EditorHidden is an editor-only marker; the entComponents walk surfaces it from
// the active world.
function isEntHidden(world: World, handle: EntityHandle): boolean {
  return 'EditorHidden' in entComponents(world, handle);
}

// ── runtime wiring ────────────────────────────────────────────────────────────

interface AssetsLike {
  register?(desc: unknown): { unwrap(): unknown };
}

// M4: EngineSync dependency removed — world is SSOT, no doc→world mapping needed.
export interface ViewportDeps {
  canvas: HTMLCanvasElement;
  /** M3 t16 (S4 / AC-05, plan-strategy §2 D-2, research F-3): the view scaffolding
   *  no longer receives the raw engine World. It receives the core-minted
   *  EngineFacade — the sole controlled write proxy (ctx.engine). Every
   *  camera/gizmo/preview write goes through it, so the write is trace-visible and
   *  the raw World is out of view-layer reach (AC-04 grep goes to zero). Same-name
   *  same-shape methods (set/spawn/despawn/allocSharedRef) mean call sites change
   *  only their receiver, not their shape (AC-06 no-regression). */
  engine: EngineFacade;
  /** M4 (w19/w20, plan-strategy §2 D-2/D-5): the DEDICATED EngineFacade for the
   *  editorWorld — camera + gizmo/param-gizmo writes go through THIS, not `engine`
   *  (which binds to the sceneWorld / doc.world). The two-facade split is the
   *  structural guarantee of AC-01: editor entities only ever land in editorWorld.
   *  Reads of the SELECTED sceneWorld entity (updateGizmo / pick / param-gizmo)
   *  still go through `engine` / gateway.activeWorld — super moves VALUES across
   *  worlds, never entity identity (requirements S5 "只搬值不搬身份"). */
  editorEngine: EngineFacade;
  assets?: AssetsLike;   // legacy slot — gizmo handle materials now mint via engine.allocSharedRef
  camera: EntityHandle;  // the editor camera entity (editorEngine.spawn().unwrap() handle in editorWorld)
  /** Optional initial orbit framing — asset-edit mode opens close-up on the
   *  origin instead of the arena-scale default. */
  initialOrbit?: { target?: [number, number, number]; yaw?: number; pitch?: number; dist?: number };
  /** Live read of the current input owner (requirements C-4). When it returns
   *  'game' (only the play·game quadrant) the editor's orbit/pick/gizmo handlers
   *  early-return so DOM events pass through to the game's InputBackend. Defaults
   *  to always-'editor' until the run/display state machine (w22) wires the real
   *  derivation. The viewport never stores run/display itself — it only reads
   *  inputTarget through this accessor (SSOT lives upstream). */
  getInputTarget?: () => InputTarget;
}

export interface Viewport {
  dispose(): void;
  /** Re-aim the camera (e.g. on resize the aspect changes). */
  refresh(): void;
  /** Re-aim the orbit camera to a default ~human-character framing (requirements §4.1). */
  resetCamera(): void;
}

const FOV = Math.PI / 3;

export function createViewport({ canvas, engine, editorEngine, camera, initialOrbit, getInputTarget }: ViewportDeps): Viewport {
  // M3 t19: all view-scaffold writes (camera t17 / gizmo per-frame t18 / gizmo
  // pool + param gizmo + drag fallback t19) now call the injected `engine`
  // (EngineFacade) directly — the migration bridge alias is gone, so no raw
  // `world` identifier survives in this factory (AC-04).
  // Input-routing gate (requirements C-4 / AC-10): in the play·game quadrant the
  // game owns input, so every editor handler bails before doing orbit/pick/gizmo
  // work — by EARLY-RETURN (not stopPropagation), so the same DOM event still
  // bubbles to the canvas → game InputBackend (AC-10 hard constraint).
  const inputToGame = (): boolean => (getInputTarget?.() ?? 'editor') === 'game';
  // orbit state — frames the typical arena (centered, looking slightly down).
  let target: Vec3 = initialOrbit?.target ? [...initialOrbit.target] : [0, 2, 0];
  let yaw = initialOrbit?.yaw ?? 0.6, pitch = initialOrbit?.pitch ?? -0.5, dist = initialOrbit?.dist ?? 34;

  // current camera basis (recomputed on every applyCamera).
  let camPos: Vec3 = [0, 0, 0];
  let fwd: Vec3 = [0, 0, -1], rgt: Vec3 = [1, 0, 0], upv: Vec3 = [0, 1, 0];

  const aspect = () => (canvas.clientWidth || canvas.width) / (canvas.clientHeight || canvas.height) || 1;

  function applyCamera(): void {
    const r = computeOrbitCamera(target, yaw, pitch, dist);
    camPos = r.camPos;
    fwd = r.fwd; rgt = r.rgt; upv = r.upv;
    // M4 (w19, S4 / AC-01): the orbit camera lives in the editorWorld, so its
    // per-frame Transform write goes through editorEngine (the editorWorld facade),
    // not `engine` (sceneWorld). Same-name same-shape method — the pose write is
    // byte-identical, only the target world changed (D-2 camera migration).
    // feat-20260709 array-TRS: pos[3]/quat[4]/scale[3] array columns.
    editorEngine.set(camera, Transform, {
      pos: [camPos[0], camPos[1], camPos[2]],
      quat: [r.qCam[0], r.qCam[1], r.qCam[2], r.qCam[3]],
      scale: [1, 1, 1],
    });
    // tonemap must stay active so the HDR SkyboxBackground pass draws (this set
    // replaces the Camera component each frame, so tonemap must be re-applied).
    // clearColor too: on WebKit/WKWebView (the desktop app) the cubemap skybox
    // can't render, so without a clear color the Edit viewport is pure black —
    // a neutral studio blue reads as sky. perspective() carries clearColor=[0,0,0,1],
    // so it MUST be re-applied here (this set replaces the whole Camera each frame),
    // not just at spawn. On Chromium the cubemap skybox draws over it.
    editorEngine.set(camera, Camera, { ...perspective({ fov: FOV, aspect: aspect(), near: 0.05, far: 2000 }), tonemap: TONEMAP_REINHARD_EXTENDED, clearColor: [0.42, 0.55, 0.78, 1] });
    updateGizmo();
    updateParamGizmo();
  }

  /**
   * Fly-mode per-frame update (Task 2c). Reads keyState, advances the camera
   * position along the current basis, and writes the Transform through the
   * editorEngine facade (same write channel as applyCamera, but the camera
   * source-of-truth in fly mode is `camPos + yaw/pitch` directly — no target/dist).
   * yaw/pitch are updated by onMove (mouse) — this tick only advances position.
   */
  function flyTick(): void {
    if (mode !== 'fly') { flyRAF = 0; return; }
    const now = performance.now();
    const dt = Math.min((now - lastFlyTime) / 1000, 0.1); // clamp for tab-blur spikes
    lastFlyTime = now;
    const input = getFlyInput();
    const nextFly = advanceFly({ pos: camPos, yaw, pitch }, input, flySpeed, dt);
    camPos = nextFly.pos;
    const r = computeFlyCamera(nextFly);
    fwd = r.fwd; rgt = r.rgt; upv = r.upv;
    editorEngine.set(camera, Transform, {
      pos: [camPos[0], camPos[1], camPos[2]],
      quat: [r.qCam[0], r.qCam[1], r.qCam[2], r.qCam[3]],
      scale: [1, 1, 1],
    });
    editorEngine.set(camera, Camera, {
      ...perspective({ fov: FOV, aspect: aspect(), near: 0.05, far: 2000 }),
      tonemap: TONEMAP_REINHARD_EXTENDED,
      clearColor: [0.42, 0.55, 0.78, 1],
    });
    updateGizmo();
    updateParamGizmo();
    flyRAF = requestAnimationFrame(flyTick);
  }

  // ── cameraOrbit session op (D-12 path A, S13 / AC-30) ───────────────────────
  // The orbit gesture END (onUp) single-dispatches ONE cameraOrbit session op
  // carrying the gesture-end pose. Its applier recomputes the orbit camera pose
  // and writes it through ctx.engine — the SAME move applyCamera does per frame,
  // but now as a ledger-recorded session op so collaborators (human/AI) see "the
  // camera turned to X". Critically, when an AI issues cameraOrbit over eval there
  // is NO per-frame facade write, so this applier is the ONLY path that actually
  // moves the camera — hence it must write via ctx.engine, not read viewport state.
  //
  // Session domain (registerSessionApplier): ledger +1, NO undo entry, does not
  // occupy the _activeOp lifecycle slot (so orbit-while-dragging-a-gizmo cannot
  // implicitly cancel a document begin — D-12 slot-safety). Mid-frame orbit stays
  // on the facade direct write (applyCamera), out of the ledger (OOS-4).
  //
  // M4 (w19): the camera lives in the editorWorld, so this applier writes through
  // the closure-captured `editorEngine` (editorWorld facade) — NOT ctx.engine,
  // which binds to the sceneWorld (doc.world). ctx.engine would move a nonexistent
  // sceneWorld entity and silently no-op the orbit. editorEngine still records
  // trace leaves onto the active span (the facade's _recordLeaf reads the ambient
  // active span, not a per-world binding), so ledger/trace semantics are preserved.
  const unregCameraOrbit = registerSessionApplier(
    'cameraOrbit',
    (op, _ctx): { ok: true } => {
      // T6b: cameraOrbit payload may optionally carry `pos` — if provided,
      // treat as the ground-truth camera position and DERIVE the orbit target
      // from it (target = pos + fwd * dist), so a caller expressing "put camera
      // here + look this way" doesn't need to know the target math. Legacy
      // callers passing only {target,yaw,pitch,dist} keep working (pos absent).
      const o = op as unknown as {
        target?: [number, number, number]; yaw?: number; pitch?: number; dist?: number;
        pos?: [number, number, number];
      };
      const nextYaw = o.yaw ?? yaw;
      const nextPitch = o.pitch ?? pitch;
      const nextDist = o.dist ?? dist;
      let tgt: Vec3;
      if (o.pos) {
        // Derive target from camera pos: target = pos + fwd * dist.
        const flyR = computeFlyCamera({ pos: [o.pos[0], o.pos[1], o.pos[2]], yaw: nextYaw, pitch: nextPitch });
        tgt = [
          o.pos[0] + flyR.fwd[0] * nextDist,
          o.pos[1] + flyR.fwd[1] * nextDist,
          o.pos[2] + flyR.fwd[2] * nextDist,
        ];
      } else {
        tgt = o.target ? [o.target[0], o.target[1], o.target[2]] : [...target];
      }
      const r = computeOrbitCamera(tgt, nextYaw, nextPitch, nextDist);
      editorEngine.set(camera, Transform, {
        pos: [r.camPos[0], r.camPos[1], r.camPos[2]],
        quat: [r.qCam[0], r.qCam[1], r.qCam[2], r.qCam[3]],
        scale: [1, 1, 1],
      });
      // Sync closure state so subsequent gestures build on the AI-set pose.
      target = tgt; yaw = nextYaw; pitch = nextPitch; dist = nextDist;
      camPos = r.camPos; fwd = r.fwd; rgt = r.rgt; upv = r.upv;
      return { ok: true };
    },
    { title: 'Orbit camera' },
  );

  // ── cameraFly session op (T4a) ──────────────────────────────────────────────
  // The FLY gesture end (onUp) dispatches ONE cameraFly session op carrying
  // {pos, yaw, pitch}. Applier: absolute pose write via editorEngine, and it
  // also reconstructs a reasonable orbit target so a subsequent MMB/Alt+LMB
  // gesture builds on the fly-end pose smoothly (T6a).
  const unregCameraFly = registerSessionApplier(
    'cameraFly',
    (op, _ctx): { ok: true } => {
      const o = op as unknown as {
        pos?: [number, number, number]; yaw?: number; pitch?: number;
      };
      const p: Vec3 = o.pos ? [o.pos[0], o.pos[1], o.pos[2]] : [...camPos];
      const nextYaw = o.yaw ?? yaw;
      const nextPitch = o.pitch ?? pitch;
      const r = computeFlyCamera({ pos: p, yaw: nextYaw, pitch: nextPitch });
      editorEngine.set(camera, Transform, {
        pos: [r.camPos[0], r.camPos[1], r.camPos[2]],
        quat: [r.qCam[0], r.qCam[1], r.qCam[2], r.qCam[3]],
        scale: [1, 1, 1],
      });
      // Sync closure state + reconstruct orbit target for smooth orbit ← fly switch.
      camPos = r.camPos; yaw = nextYaw; pitch = nextPitch;
      fwd = r.fwd; rgt = r.rgt; upv = r.upv;
      const orb = flyToOrbit({ pos: p, yaw: nextYaw, pitch: nextPitch }, dist);
      target = orb.target; dist = orb.dist;
      return { ok: true };
    },
    { title: 'Fly camera to position' },
  );

  // ── cameraTeleport session op (T4b) ─────────────────────────────────────────
  // AI-first absolute pose teleport. Semantically same effect as cameraFly, but
  // named "teleport" because there is no human gesture — AI just says "camera
  // goes here now". Same applier body; separate kind for ledger/self-introspection.
  const unregCameraTeleport = registerSessionApplier(
    'cameraTeleport',
    (op, _ctx): { ok: true } => {
      const o = op as unknown as {
        pos?: [number, number, number]; yaw?: number; pitch?: number;
      };
      const p: Vec3 = o.pos ? [o.pos[0], o.pos[1], o.pos[2]] : [...camPos];
      const nextYaw = o.yaw ?? yaw;
      const nextPitch = o.pitch ?? pitch;
      const r = computeFlyCamera({ pos: p, yaw: nextYaw, pitch: nextPitch });
      editorEngine.set(camera, Transform, {
        pos: [r.camPos[0], r.camPos[1], r.camPos[2]],
        quat: [r.qCam[0], r.qCam[1], r.qCam[2], r.qCam[3]],
        scale: [1, 1, 1],
      });
      camPos = r.camPos; yaw = nextYaw; pitch = nextPitch;
      fwd = r.fwd; rgt = r.rgt; upv = r.upv;
      const orb = flyToOrbit({ pos: p, yaw: nextYaw, pitch: nextPitch }, dist);
      target = orb.target; dist = orb.dist;
      return { ok: true };
    },
    { title: 'Teleport camera to position' },
  );

  // ── cameraLookAt session op (T4c) ───────────────────────────────────────────
  // AI-friendly: specify {pos, lookAt} instead of {pos, yaw, pitch}. yaw/pitch
  // are derived from the (pos → lookAt) vector using the engine convention:
  //   forward = qCam · [0,0,-1] with qCam = yaw·Y × pitch·X
  //   → yaw = atan2(-dx, -dz),  pitch = atan2(dy, hypot(dx,dz))
  // (matches the plan's derivation; verified by advanceFly at yaw=0 → -Z).
  const unregCameraLookAt = registerSessionApplier(
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
      editorEngine.set(camera, Transform, {
        pos: [r.camPos[0], r.camPos[1], r.camPos[2]],
        quat: [r.qCam[0], r.qCam[1], r.qCam[2], r.qCam[3]],
        scale: [1, 1, 1],
      });
      camPos = r.camPos; yaw = calcYaw; pitch = calcPitch;
      fwd = r.fwd; rgt = r.rgt; upv = r.upv;
      const orb = flyToOrbit({ pos: p, yaw: calcYaw, pitch: calcPitch }, dist);
      target = orb.target; dist = orb.dist;
      return { ok: true };
    },
    { title: 'Move camera and look at target' },
  );

  // ── requestFrame session op (D-10 → edit-runtime migration) ─────────────────
  // The "frame selection in viewport" pulse. Inspector Focus button and AI both
  // dispatch { kind: 'requestFrame' } through the gateway; the applier calls the
  // closure-local frameSelection() which re-aims the orbit camera on the selected
  // entity. Same registerSessionApplier pattern as cameraOrbit / play / stop.
  const unregRequestFrame = registerSessionApplier(
    'requestFrame',
    (_op, _ctx): { ok: true } => {
      frameSelection();
      return { ok: true };
    },
    { title: 'Frame selection in viewport' },
  );

  // ── gizmo (3 axis handles on the selection) ────────────────────────────────
  // Shape follows the mode (design §3): translate/scale → axis BARS; rotate →
  // axis RINGS (circles in each axis plane). Rings are built from a pool of small
  // cube segments (a torus mesh isn't in the handle set), reused frame-to-frame so
  // orbiting/dragging only world.set transforms — never respawns.
  // AXES / PLANES / RING_SEG / TIP_QUAT are the shared gizmo layout constants,
  // now imported from viewport-gizmo-geometry.ts (M6 extraction, AC-08).
  let gizmoMats: Handle<'MaterialAsset', 'shared'>[] | null = null;
  type Shape = 'translate' | 'scale' | 'rings';
  let shape: Shape | null = null;
  // bars: per-axis entity + world AABB (hit-test). planes: per-plane quad entity +
  // AABB (translate only). rings: pooled segment entities (3·RING_SEG) + the ring
  // center/radius for analytic plane hit-test.
  // Gizmo entities are minted by engine.spawn().unwrap() → genuine branded
  // EntityHandle values; type them as such so engine.set/despawn (now strict
  // after the facade tightening) accept them without a per-call brand cast.
  let barEnts: EntityHandle[] = [];
  let bars: { center: Vec3; half: Vec3 }[] = [];
  let tipEnts: EntityHandle[] = [];   // cone arrowheads on the translate bars
  let planeEnts: EntityHandle[] = [];
  let planes: { center: Vec3; half: Vec3 }[] = [];
  let ringEnts: EntityHandle[] = [];
  let ringCenter: Vec3 = [0, 0, 0];
  let ringRadius = 0;

  // A small cone mesh (apex at +Y, base ring at Y=0, closed) for the translate
  // arrowheads. Unlit material ignores normals/uv, so those are dummy. Built
  // once and reused for all three axes (oriented via per-axis quaternion).
  let coneMesh: Handle<'MeshAsset', 'shared'> | null = null;
  function ensureCone(): Handle<'MeshAsset', 'shared'> {
    if (coneMesh) return coneMesh;
    // Cone vertex/index geometry is pure (viewport-gizmo-geometry.ts); only the
    // allocSharedRef upload stays here (the one side-effecting edge).
    // M4 (w20): gizmo mesh asset is alloc'd on the editorWorld (editorEngine) —
    // gizmo entities live there and the renderer resolves material/mesh handles
    // per-world (D-2), so the shared ref must be minted on the same world.
    const { vertices, indices } = buildConeMeshData();
    coneMesh = editorEngine.allocSharedRef('MeshAsset', meshFromInterleaved(vertices, indices));
    return coneMesh;
  }

  function ensureMats(): Handle<'MaterialAsset', 'shared'>[] {
    if (!gizmoMats) gizmoMats = AXES.map((a) => {
      // Always-on-top gizmo: draw in the Overlay queue (4000, drawn last) with
      // depthCompare:'always' + no depth write, so the handles are never hidden
      // behind the (possibly huge) object they're anchored on.
      const base = Materials.unlit([a.color[0], a.color[1], a.color[2], 1], { castShadow: false }) as {
        passes?: { queue?: number; renderState?: Record<string, unknown> }[];
      };
      const mat = {
        ...base,
        passes: (base.passes ?? []).map((p) => ({
          ...p,
          queue: 4000, // RenderQueue.Overlay — drawn after all opaque geometry
          renderState: { ...(p.renderState ?? {}), depthCompare: 'always', depthWriteEnabled: false },
        })),
      };
      // M4 (w20): gizmo material minted on editorWorld (editorEngine). Overlay
      // queue=4000 + depthCompare:'always' + depthWriteEnabled:false mechanism is
      // unchanged (AC-03 topmost) — only the target world moved.
      return editorEngine.allocSharedRef('MaterialAsset', mat);
    });
    return gizmoMats;
  }
  function spawnHandleMesh(
    mesh: Handle<'MeshAsset', 'shared'>,
    material: Handle<'MaterialAsset', 'shared'>,
  ): EntityHandle {
    // M4 (w20): gizmo entities spawn into the editorWorld (editorEngine) — the
    // structural half of AC-01 (gizmo can never land in the sceneWorld).
    return editorEngine.spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      // engine #317: MeshRenderer.material (single) -> materials[]. Passing the
      // legacy single field leaves the gizmo unmaterialed -> default gray axes.
      { component: MeshRenderer, data: { materials: [material] } },
    ).unwrap();
  }
  const spawnHandleCube = (material: Handle<'MaterialAsset', 'shared'>): EntityHandle =>
    spawnHandleMesh(HANDLE_CUBE, material);
  function despawnHandles(): void {
    // M4 (w20): gizmo entities live in editorWorld → despawn through editorEngine.
    for (const e of barEnts) { try { editorEngine.despawn(e); } catch { /* gone */ } }
    for (const e of tipEnts) { try { editorEngine.despawn(e); } catch { /* gone */ } }
    for (const e of planeEnts) { try { editorEngine.despawn(e); } catch { /* gone */ } }
    for (const e of ringEnts) { try { editorEngine.despawn(e); } catch { /* gone */ } }
    barEnts = []; bars = []; tipEnts = []; planeEnts = []; planes = []; ringEnts = []; shape = null;
  }
  function buildShape(want: Shape): void {
    const mats = ensureMats();
    if (want === 'rings') {
      ringEnts = [];
      for (let i = 0; i < AXES.length; i++) for (let j = 0; j < RING_SEG; j++) ringEnts.push(spawnHandleCube(mats[i]!));
    } else {
      barEnts = AXES.map((_, i) => spawnHandleCube(mats[i]!));
      bars = AXES.map(() => ({ center: [0, 0, 0] as Vec3, half: [0, 0, 0] as Vec3 }));
      if (want === 'translate') {
        // Cone arrowheads at each axis tip (move gizmo only).
        const cone = ensureCone();
        tipEnts = AXES.map((_, i) => spawnHandleMesh(cone, mats[i]!));
        planeEnts = PLANES.map((p) => spawnHandleCube(mats[p.mat]!));
        planes = PLANES.map(() => ({ center: [0, 0, 0] as Vec3, half: [0, 0, 0] as Vec3 }));
      }
    }
    shape = want;
  }
  function positionBars(center: Vec3, len: number, thick: number): void {
    const hasTips = tipEnts.length > 0;
    const tipLen = len * 0.34, tipRad = thick * 2.6;
    AXES.forEach((a, i) => {
      const hc: Vec3 = [center[0] + a.axis[0] * len / 2, center[1] + a.axis[1] * len / 2, center[2] + a.axis[2] * len / 2];
      const sx = a.axis[0] ? len : thick, sy = a.axis[1] ? len : thick, sz = a.axis[2] ? len : thick;
      editorEngine.set(barEnts[i]!, Transform, { pos: [hc[0], hc[1], hc[2]], scale: [sx, sy, sz] });
      if (hasTips) {
        // Cone base sits at the bar's outer end, apex pointing further out along
        // the axis. scaleY is the cone's local height (→ length after the +Y→axis
        // rotation); scaleX/Z are the base radius.
        const base: Vec3 = [center[0] + a.axis[0] * len, center[1] + a.axis[1] * len, center[2] + a.axis[2] * len];
        const q = TIP_QUAT[i]!;
        editorEngine.set(tipEnts[i]!, Transform, {
          pos: [base[0], base[1], base[2]],
          scale: [tipRad, tipLen, tipRad],
          quat: [q[0], q[1], q[2], q[3]],
        });
        // Extend the grab AABB to the cone apex so the whole arrow is clickable.
        const reach = len + tipLen;
        bars[i]!.center = [center[0] + a.axis[0] * reach / 2, center[1] + a.axis[1] * reach / 2, center[2] + a.axis[2] * reach / 2];
        const gx = a.axis[0] ? reach : thick, gy = a.axis[1] ? reach : thick, gz = a.axis[2] ? reach : thick;
        bars[i]!.half = [gx / 2, gy / 2, gz / 2];
      } else {
        bars[i]!.center = hc;
        bars[i]!.half = [sx / 2, sy / 2, sz / 2];
      }
    });
  }
  function positionPlanes(center: Vec3, len: number, thick: number): void {
    const off = len * 0.34, quad = len * 0.22;
    PLANES.forEach((p, i) => {
      const ax = AXES[p.ax]!.axis, ay = AXES[p.ay]!.axis;
      const hc: Vec3 = [
        center[0] + (ax[0] + ay[0]) * off, center[1] + (ax[1] + ay[1]) * off, center[2] + (ax[2] + ay[2]) * off,
      ];
      // flat quad: ~quad along the two in-plane axes, ~thick along the normal.
      const s: Vec3 = [
        p.normal[0] ? thick : quad, p.normal[1] ? thick : quad, p.normal[2] ? thick : quad,
      ];
      editorEngine.set(planeEnts[i]!, Transform, { pos: [hc[0], hc[1], hc[2]], scale: [s[0], s[1], s[2]] });
      planes[i]!.center = hc;
      planes[i]!.half = [s[0] / 2, s[1] / 2, s[2] / 2];
    });
  }
  function positionRings(center: Vec3, len: number, thick: number): void {
    ringCenter = center; ringRadius = len;
    const seg = thick * 1.3;
    for (let i = 0; i < AXES.length; i++) {
      const [u, v] = orthoBasis(AXES[i]!.axis);
      for (let j = 0; j < RING_SEG; j++) {
        const th = (j / RING_SEG) * Math.PI * 2;
        const c = Math.cos(th) * len, s = Math.sin(th) * len;
        const p: Vec3 = [center[0] + u[0] * c + v[0] * s, center[1] + u[1] * c + v[1] * s, center[2] + u[2] * c + v[2] * s];
        editorEngine.set(ringEnts[i * RING_SEG + j]!, Transform, { pos: [p[0], p[1], p[2]], scale: [seg, seg, seg] });
      }
    }
  }
  /** Re-place the gizmo on the current selection (or hide it). Sized by camera
   *  distance so handles stay grabbable at any zoom; shape switches with the mode. */
  function updateGizmo(): void {
    // Display gate (w23, D-5): display='game' → hide ALL auxiliary entities.
    if (!isAuxVisible()) { despawnHandles(); return; }
    const sel = getSelection();
    // Read the world-space transform from the engine — the gateway.update / engine.set
    // in applyLive has already recomputed the world matrix, so there is no lag.
    const t = sel !== null ? readWorldTransform(gateway.activeWorld, sel) : undefined;
    if (sel === null || !t) { despawnHandles(); return; }
    const center: Vec3 = [num(t.x, 0), num(t.y, 0), num(t.z, 0)];
    const len = dist * 0.13, thick = dist * 0.007; // thinner handles (½ of the old 0.014)
    const gm = getGizmoMode();
    const want: Shape = gm === 'rotate' ? 'rings' : gm === 'scale' ? 'scale' : 'translate';
    if (shape !== want) { despawnHandles(); buildShape(want); }
    if (want === 'rings') { positionRings(center, len, thick); return; }
    positionBars(center, len, thick);
    if (want === 'translate') positionPlanes(center, len, thick);
  }
  /** Which gizmo handle (if any) the ray hits — checked before entity picking.
   *  Returns 0-2 for an axis bar/ring; 3-5 (= 3 + plane index) for a plane handle.
   *  Bars/planes: ray vs AABB. Rings: ray hits the axis plane near the ring radius. */
  function hitGizmo(origin: Vec3, dir: Vec3): number | null {
    let best: number | null = null, bestT = Infinity;
    if (shape === 'rings') {
      const band = Math.max(ringRadius * 0.18, 1e-4);
      for (let i = 0; i < AXES.length; i++) {
        const hit = rayPlane(origin, dir, ringCenter, AXES[i]!.axis);
        if (!hit) continue;
        const r = Math.hypot(hit[0] - ringCenter[0], hit[1] - ringCenter[1], hit[2] - ringCenter[2]);
        if (Math.abs(r - ringRadius) > band) continue;
        const td = Math.hypot(hit[0] - origin[0], hit[1] - origin[1], hit[2] - origin[2]);
        if (td < bestT) { bestT = td; best = i; }
      }
      return best;
    }
    // plane handles take priority over the bars they sit between (translate only).
    for (let i = 0; i < planes.length; i++) {
      const h = planes[i]!;
      const t = rayAABB(origin, dir, h.center, h.half);
      if (t !== null && t < bestT) { bestT = t; best = 3 + i; }
    }
    for (let i = 0; i < bars.length; i++) {
      const h = bars[i]!;
      const t = rayAABB(origin, dir, h.center, h.half);
      if (t !== null && t < bestT) { bestT = t; best = i; }
    }
    return best;
  }

  // ── parameter gizmos (design §3): visualize a selected Light's range/spot cone
  // and a Camera's frustum as dotted world-space wireframes (non-interactive).
  // Built from a reused cube-dot pool; rebuilt cheaply via placeDots (only spawns
  // when the dot count changes), so orbiting just re-sets transforms. ──
  let paramEnts: EntityHandle[] = [];
  let paramMat: Handle<'MaterialAsset', 'shared'> | null = null;
  function ensureParamMat(): Handle<'MaterialAsset', 'shared'> {
    // M4 (w20): param-gizmo material minted on editorWorld (editorEngine).
    if (!paramMat) paramMat = editorEngine.allocSharedRef('MaterialAsset', Materials.unlit([1.0, 0.82, 0.25, 1], { castShadow: false }));
    return paramMat;
  }
  function despawnParam(): void {
    // M4 (w20): param-gizmo entities live in editorWorld → despawn via editorEngine.
    for (const e of paramEnts) { try { editorEngine.despawn(e); } catch { /* gone */ } }
    paramEnts = [];
  }
  function placeDots(points: Vec3[], size: number): void {
    if (points.length === 0) { despawnParam(); return; }
    const mat = ensureParamMat();
    while (paramEnts.length < points.length) paramEnts.push(spawnHandleCube(mat));
    while (paramEnts.length > points.length) { const e = paramEnts.pop()!; try { editorEngine.despawn(e); } catch { /* gone */ } }
    points.forEach((p, i) => editorEngine.set(paramEnts[i]!, Transform, { pos: [p[0], p[1], p[2]], scale: [size, size, size] }));
  }
  /** Re-draw the parameter gizmo for the current selection (light/camera) or hide. */
  function updateParamGizmo(): void {
    // Display gate (w23): display='game' → hide param gizmos (Light range/spot, Camera frustum).
    if (!isAuxVisible()) { despawnParam(); return; }
    const sel = getSelection();
    // M7-a (AC-15): read the selected entity's components from the world (SSOT),
    // not the deleted doc.entities mirror. entComponents returns component-name →
    // POD for every component the entity carries.
    const comps = sel !== null ? entComponents(gateway.activeWorld, sel) : undefined;
    if (!comps || Object.keys(comps).length === 0) { despawnParam(); return; }
    const t = sel !== null ? readWorldTransform(gateway.activeWorld, sel) : undefined;
    const center: Vec3 = [num(t?.x, 0), num(t?.y, 0), num(t?.z, 0)];
    const light = comps.Light as Record<string, unknown> | undefined;
    const cam = comps.Camera as Record<string, unknown> | undefined;
    // The wireframe POINT SETS are pure geometry (viewport-gizmo-geometry.ts); the
    // engine dot-pool placement (placeDots) is the only side-effecting edge here.
    const pts: Vec3[] = [];
    if (light) pts.push(...lightGizmoPoints(light, center, t, dist));
    if (cam) pts.push(...cameraGizmoPoints(cam, center, t, dist, aspect()));
    placeDots(pts, Math.max(0.05, dist * 0.006));
  }

  // ── animation scrub preview (Timeline) ──────────────────────────────────────
  function rayAt(clientX: number, clientY: number): { origin: Vec3; dir: Vec3 } {
    const r = canvas.getBoundingClientRect();
    const [nx, ny] = ndcFromClient(clientX - r.left, clientY - r.top, r.width, r.height);
    return { origin: camPos, dir: rayDirection(fwd, rgt, upv, nx, ny, FOV, aspect()) };
  }

  /**
   * Walk up the ChildOf hierarchy from `handle` until we find an editor-level
   * entity. M3 (I1): handle IS identity, so an "editor-level" entity is one the
   * editor authors — it carries a Name (entExists). This resolves internal mesh
   * entities (e.g. inside a GLB mount, which have no Name) to their named
   * editor-level ancestor. Returns the handle, or null if hidden / none found.
   */
  function resolveEditorEntity(world: World, handle: EntityHandle): EntityHandle | null {
    let cur: EntityHandle | undefined = handle;
    const seen = new Set<number>();
    while (cur !== undefined) {
      if (seen.has(cur as number)) break;
      seen.add(cur as number);
      if (entExists(world, cur)) return isEntHidden(world, cur) ? null : cur;
      // merge origin/main: main's ChildOf-walk read the raw `world`; the IoC
      // refactor removed that binding — reads go through the injected facade.
      const co = engine.get(cur, ChildOf) as { ok: true; value: { parent: number } } | { ok: false };
      if (!co.ok) break;
      cur = (co.value as { parent: number }).parent as EntityHandle;
    }
    return null;
  }

  /** Nearest visible world entity hit by the ray (or null).
   *  Tries engine pick first (mesh-aware, uses MeshAsset.aabb); if that misses
   *  (e.g. because the engine hasn't populated .aabb yet — see engine feedback
   *  2026-07-06), falls back to the editor's Transform-scale AABB sweep. */
  function pick(clientX: number, clientY: number): EntityHandle | null {
    const r = canvas.getBoundingClientRect();
    const sx = clientX - r.left, sy = clientY - r.top;
    // merge origin/main: enginePick needs the raw engine World (read-only,
    // mesh-aware). The IoC refactor removed the direct `world` binding, so reach
    // it through the facade's read-only escape hatch (no write → gate-A clean).
    const w = engine._rawWorld();
    const activeWorld = gateway.activeWorld;

    // 1) Engine pick (precise, mesh-level AABB + world matrix). SUPER GUARD (w29,
    //    S5/RD3): engine `pick(world, cameraEntity)` reads BOTH the camera AND the
    //    geometry from ONE world. Post-split the camera lives in editorWorld and
    //    the authored geometry in sceneWorld — feeding the editorWorld camera
    //    HANDLE into a sceneWorld pick would MOVE IDENTITY across worlds (the exact
    //    anti-pattern: the (index,gen) could resolve to a coincidental sceneWorld
    //    entity → wrong Camera → wrong ray, silently). So only take the engine fast
    //    path when the camera actually co-resides in the pick world; otherwise fall
    //    through to the CPU sweep, which is the super VALUE-move (camera basis is
    //    computed in the editorWorld orbit state, applied to a sceneWorld geometry
    //    walk — values cross, identity does not). Restoring mesh-precision picking
    //    across the split needs an engine pick that separates camera-source-world
    //    from geometry-world (engine-repo change, out of scope for editor-only M5).
    if (w.get(camera as unknown as EntityHandle, Camera).ok) {
      try {
        const hit = enginePick(w, camera as unknown as EntityHandle, sx, sy, r.width, r.height);
        if (hit) {
          const resolved = resolveEditorEntity(activeWorld, hit.entity as EntityHandle);
          if (resolved !== null) return resolved;
        }
      } catch (e) {
        if (!(e instanceof PickError)) throw e;
      }
    }

    // 2) Super value-move pick: editor-camera-basis ray vs sceneWorld Transform-AABB.
    //    Only test entities that carry MeshFilter + MeshRenderer — lights,
    //    cameras, and empty group nodes have no visual representation and
    //    must not be selectable via the fallback (matches engine pick's
    //    candidate set). See feedback 2026-07-07.
    const { origin, dir } = rayAt(clientX, clientY);
    let best: EntityHandle | null = null, bestT = Infinity;
    for (const id of worldEntityHandles(activeWorld)) {
      if (isEntHidden(activeWorld, id)) continue;
      const comps = entComponents(activeWorld, id);
      if (!('MeshFilter' in comps) || !('MeshRenderer' in comps)) continue;
      const t = readWorldTransform(activeWorld, id);
      if (!t) continue;
      const { center, half } = entityBox(t);
      const hit = rayAABB(origin, dir, center, half);
      if (hit !== null && hit < bestT) { bestT = hit; best = id; }
    }
    return best;
  }

  // ── pointer interaction ──
  // UE5 fly mode: RMB drag = free-look + WASD/QE keyboard-driven flight (rAF loop).
  type Mode = 'none' | 'orbit' | 'pan' | 'zoom' | 'fly' | 'pendDrag' | 'drag' | 'axisDrag';
  let mode: Mode = 'none';
  let lastX = 0, lastY = 0, downX = 0, downY = 0;
  // ── fly-mode state (Task 2b + T5: speed persists across gestures) ──────────
  let flySpeed = FLY_SPEED_DEFAULT;
  let flyRAF = 0;
  let lastFlyTime = 0;
  /** Held-key snapshot (fly mode reads every rAF tick).
   *  Populated by window keydown/keyup so keys pressed BEFORE RMB down still count. */
  const keyState: Record<string, boolean> = Object.create(null);
  function getFlyInput(): FlyInput {
    return {
      forward: !!keyState['w'],
      backward: !!keyState['s'],
      left: !!keyState['a'],
      right: !!keyState['d'],
      up: !!keyState['e'],
      down: !!keyState['q'],
    };
  }
  let dragId: EntityHandle | null = null;
  // M4: entity IDs are directly world entities, so the drag target legacy id IS
  // the engine handle at runtime — brand it at the assignment seam (mirrors core's
  // toEntity) so the strict-typed engine.set fallback write below accepts it.
  let dragWorld: EntityHandle | undefined;
  // M3 (D-9): the gizmo drag is a DOCUMENT continuous op. The gateway lifecycle
  // handle is opened lazily on the first live change (so a plain click that never
  // drags opens nothing) and closed on pointerup via commit (one undoable command)
  // or cancel (no net change). null = no lifecycle open.
  let dragHandle: OpHandle | null = null;
  let dragOrig: Record<string, number> = {};
  // World-space entity center at drag start (for gizmo ray-plane math and
  // rebuilding absolute targets before converting through the parent transform).
  let dragWorldPos: Vec3 = [0, 0, 0];
  let grabOffset: Vec3 = [0, 0, 0];
  let dragY = 0;
  // axis-constrained drag (gizmo handle): which axis + the entity center at grab,
  // plus the axis parameter (translate/scale) or plane angle (rotate) at grab so
  // motion is relative (no jump-to-cursor).
  let axisIdx = 0;
  let axisVec: Vec3 = [1, 0, 0];
  let axisStart: Vec3 = [0, 0, 0];
  let axisT0 = 0;
  let angle0 = 0;
  // plane-handle drag (translate only): which plane + the ray∩plane point at grab.
  let dragPlane: PlaneHandle | null = null;
  let planeGrab: Vec3 = [0, 0, 0];
  // the changed Transform fields, committed as ONE command on release.
  let livePatch: Record<string, number> = {};
  const qd = quat.create();

  /** Convert an editor-shape Transform (x/y/z + rotX/rotY/rotZ + scale) into the
   *  engine-native POD (pos[3] + quat[4] + scale[3] arrays — feat-20260709). M7-a:
   *  the world is the SSOT — both the live preview (world.set) and the commit
   *  (setComponent → document.ts w.set) must write engine array fields, not the
   *  editor euler shape. euler→quat uses XYZ order (euler-quat.ts SSOT, AGENTS.md #6). */
  const toEnginePatch = (m: Record<string, number>): Record<string, number[]> => {
    const data: Record<string, number[]> = {
      pos: [num(m.x, 0), num(m.y, 0), num(m.z, 0)],
      scale: [num(m.scaleX, 1), num(m.scaleY, 1), num(m.scaleZ, 1)],
    };
    const rx = num(m.rotX, 0), ry = num(m.rotY, 0), rz = num(m.rotZ, 0);
    if (rx || ry || rz) {
      quat.fromEuler(qd, rx * DEG2RAD, ry * DEG2RAD, rz * DEG2RAD, 'XYZ');
      data.quat = [qd[0]!, qd[1]!, qd[2]!, qd[3]!];
    } else { data.quat = [0, 0, 0, 1]; }
    return data;
  };

  /** Live-preview a Transform patch through the gateway lifecycle (D-9). The
   *  document-continuous op opens lazily on the first live change (begin snapshots
   *  the pre-drag pose), then each drag frame is a gateway.update — no ledger/undo
   *  growth per frame, exactly as the old world.set preview did, but now through
   *  the single door so the whole drag commits as ONE undoable setComponent on
   *  release (onUp). Position + scale + rotation(quat from euler) all applied. */
  const applyLive = (patch: Record<string, number>): void => {
    livePatch = patch;
    if (dragWorld === undefined || dragId === null) return;
    const enginePatch = toEnginePatch({ ...dragOrig, ...patch });
    if (dragHandle === null) {
      // Open the op: begin snapshots the pre-drag pose (dragOrig). If the entity
      // vanished mid-interaction, fall back to a direct preview write.
      const b = gateway.begin({ kind: 'setComponent', entity: dragId, component: 'Transform', patch: toEnginePatch(dragOrig) });
      if (b.ok) dragHandle = b.handle;
    }
    if (dragHandle !== null) {
      // update writes the live pose (revert-to-begin + re-apply); no ledger/undo.
      gateway.update(dragHandle, { patch: enginePatch });
    } else {
      engine.set(dragWorld, Transform, enginePatch);
    }
    // Mirror the changed fields into the Inspector live via the transient
    // field-preview op — numbers track the drag; the single commit lands on release.
    for (const k in patch) gateway.dispatch({ kind: 'setFieldPreview', id: dragId, key: `Transform.${k}`, value: patch[k]! });
  };
  const snap = (v: number, step: number, on: boolean): number => (on ? Math.round(v / step) * step : v);
  const ROT_KEYS = ['rotX', 'rotY', 'rotZ'];
  const SCALE_KEYS = ['scaleX', 'scaleY', 'scaleZ'];

  // The viewport is a physical canvas boundary. Events outside it belong to the
  // browser/UI by construction; no selector whitelist or scrollability inference
  // is needed to decide who owns a wheel or pointer gesture.
  const inCanvas = (target: EventTarget | null): boolean =>
    target === canvas || canvas.contains(target as Node | null);

  function onDown(e: PointerEvent): void {
    if (!inCanvas(e.target)) return;
    if (inputToGame()) return;
    canvas.focus({ preventScroll: true });
    lastX = downX = e.clientX; lastY = e.clientY;
    // UE5 editor navigation (feedback 2026-07-16):
    //   RMB (hold)  = FLY MODE (free-look + WASD/QE + scroll = speed)
    //   Alt + RMB   = zoom / dolly
    //   MMB drag    = pan (no modifier)
    //   Alt + LMB   = orbit (tumble around target)
    //   LMB         = select / gizmo (reserved, unchanged)
    // RMB (button 2)
    if (e.button === 2) {
      if (e.altKey) {
        // Alt + RMB = dolly / zoom (UE5 alt-drag zoom).
        mode = 'zoom';
      } else {
        // Enter fly mode: rAF loop reads keyState + advances the camera position
        // along the current basis; onMove handles free-look mouse deltas.
        mode = 'fly';
        // Attempt to capture pointer so the fly-look tracks even when the mouse
        // leaves the canvas (fires "pointermove" via setPointerCapture semantics).
        try { canvas.setPointerCapture(e.pointerId); } catch { /* not supported */ }
        lastFlyTime = performance.now();
        if (flyRAF === 0) flyRAF = requestAnimationFrame(flyTick);
      }
      e.preventDefault();
      return;
    }
    // MMB (button 1) = pan
    if (e.button === 1) {
      mode = 'pan';
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    // Alt + LMB = orbit (UE5 tumble; also Mac trackpad "Emulate 3-Button Mouse")
    if (e.altKey) {
      mode = (e.ctrlKey || e.metaKey) ? 'zoom' : (e.shiftKey ? 'pan' : 'orbit');
      e.preventDefault();
      return;
    }
    const { origin, dir } = rayAt(e.clientX, e.clientY);
    // gizmo handles take priority over entity/orbit picking.
    const sel = getSelection();
    const h = sel !== null ? hitGizmo(origin, dir) : null;
    if (h !== null && sel !== null) {
      dragId = sel;
// M4: worldEntityFor removed — entity IDs are directly world entities.
      dragWorld = sel as unknown as EntityHandle;
      // Read both LOCAL (drag write-back) and WORLD (gizmo ray-plane math) at grab.
      const localT = readLocalTransform(gateway.activeWorld, sel);
      dragOrig = { ...(localT ?? {}) };
      const worldT = readWorldTransform(gateway.activeWorld, sel);
      dragWorldPos = [num(worldT?.x, 0), num(worldT?.y, 0), num(worldT?.z, 0)];
      axisStart = [...dragWorldPos];
      livePatch = {};
      if (h >= 3) {
        // a plane handle: drag two axes on the plane ⊥ its normal.
        dragPlane = PLANES[h - 3]!;
        const g = rayPlane(origin, dir, axisStart, dragPlane.normal);
        planeGrab = g ?? [...axisStart];
      } else {
        dragPlane = null;
        axisIdx = h;
        axisVec = AXES[h]!.axis;
        if (getGizmoMode() === 'rotate') angle0 = angleOnAxis(origin, dir, axisStart, axisVec) ?? 0;
        else axisT0 = closestAxisT(origin, dir, axisStart, axisVec);
      }
      mode = 'axisDrag';
      return;
    }
    const hit = pick(e.clientX, e.clientY);
    if (hit !== null) {
      gateway.dispatch({ kind: 'setSelection', id: hit });
      dragId = hit;
      dragWorld = hit as unknown as EntityHandle;
      // Read both LOCAL (for write-back) and WORLD (for ray-plane math).
      const localT = readLocalTransform(gateway.activeWorld, hit);
      dragOrig = { ...(localT ?? {}) };
      const worldT = readWorldTransform(gateway.activeWorld, hit);
      dragWorldPos = [num(worldT?.x, 0), num(worldT?.y, 0), num(worldT?.z, 0)];
      dragY = num(worldT?.y, 0);
      const g = rayPlaneY(origin, dir, dragY);
      grabOffset = g ? [dragWorldPos[0] - g[0], 0, dragWorldPos[2] - g[2]] : [0, 0, 0];
      mode = 'pendDrag';
    } else {
      gateway.dispatch({ kind: 'setSelection', id: null });
      mode = 'none';
    }
  }

  function onMove(e: PointerEvent): void {
    if (inputToGame()) return;
    if (mode === 'none') return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (mode === 'fly') {
      // UE5 free-look while RMB held: mouse dx/dy → yaw/pitch delta.
      // Position advance happens in flyTick (rAF loop), so we only rotate here.
      const look = advanceFlyLook({ pos: camPos, yaw, pitch }, -dx * 0.003, -dy * 0.003);
      yaw = look.yaw; pitch = look.pitch;
      // Note: intentionally NOT calling flyTick here — the rAF loop is the SSOT
      // for the per-frame camera write. This handler just updates yaw/pitch;
      // the next flyTick will pick them up and re-apply.
      return;
    }
    if (mode === 'orbit') {
      const r = advanceOrbit(yaw, pitch, dist, -dx * 0.005, -dy * 0.005, 0);
      yaw = r.yaw; pitch = r.pitch; dist = r.dist;
      applyCamera();
    } else if (mode === 'pan') {
      const k = dist * 0.0016;
      target = [target[0] - rgt[0] * dx * k + upv[0] * dy * k,
                target[1] - rgt[1] * dx * k + upv[1] * dy * k,
                target[2] - rgt[2] * dx * k + upv[2] * dy * k];
      applyCamera();
    } else if (mode === 'zoom') {
      // Ctrl+MMB drag-zoom (Blender): drag down = zoom out, up = zoom in.
      const r = advanceOrbit(yaw, pitch, dist, 0, 0, -dy * 0.005 * dist);
      yaw = r.yaw; pitch = r.pitch; dist = r.dist;
      applyCamera();
    } else if (mode === 'axisDrag') {
      const { origin, dir } = rayAt(e.clientX, e.clientY);
      const ctrl = e.ctrlKey || e.metaKey;
      const gm = getGizmoMode();
      if (dragPlane) {
        // move two axes at once across the plane (relative to the grab point).
        const hit = rayPlane(origin, dir, axisStart, dragPlane.normal);
        if (hit) {
          const target: Vec3 = [
            dragWorldPos[0] + hit[0] - planeGrab[0],
            dragWorldPos[1] + hit[1] - planeGrab[1],
            dragWorldPos[2] + hit[2] - planeGrab[2],
          ];
          const local = worldPositionToLocal(gateway.activeWorld, dragId!, target);
          applyLive({
            x: snap(local[0], 0.5, ctrl),
            y: snap(local[1], 0.5, ctrl),
            z: snap(local[2], 0.5, ctrl),
          });
        }
      } else if (gm === 'rotate') {
        const a = angleOnAxis(origin, dir, axisStart, axisVec);
        if (a !== null) {
          const key = ROT_KEYS[axisIdx]!;
          const deg = num(dragOrig[key], 0) + (a - angle0) / DEG2RAD;
          applyLive({ [key]: snap(deg, 15, ctrl) });
        }
      } else if (gm === 'scale') {
        const delta = closestAxisT(origin, dir, axisStart, axisVec) - axisT0;
        if (e.shiftKey) {
          const patch: Record<string, number> = {};
          for (const k of SCALE_KEYS) patch[k] = Math.max(0.01, snap(num(dragOrig[k], 1) + delta, 0.25, ctrl));
          applyLive(patch);
        } else {
          const key = SCALE_KEYS[axisIdx]!;
          applyLive({ [key]: Math.max(0.01, snap(num(dragOrig[key], 1) + delta, 0.25, ctrl)) });
        }
      } else {
        const delta = closestAxisT(origin, dir, axisStart, axisVec) - axisT0;
        const target: Vec3 = [
          axisStart[0] + axisVec[0] * delta,
          axisStart[1] + axisVec[1] * delta,
          axisStart[2] + axisVec[2] * delta,
        ];
        const local = worldPositionToLocal(gateway.activeWorld, dragId!, target);
        applyLive({
          x: snap(local[0], 0.5, ctrl),
          y: snap(local[1], 0.5, ctrl),
          z: snap(local[2], 0.5, ctrl),
        });
      }
      updateGizmo(); // handles follow the entity
    } else if (mode === 'pendDrag' || mode === 'drag') {
      if (mode === 'pendDrag' && Math.hypot(e.clientX - downX, e.clientY - downY) < 4) return;
      mode = 'drag';
      const { origin, dir } = rayAt(e.clientX, e.clientY);
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.shiftKey) {
        // vertical: screen dy → world Y (scaled by distance so it tracks roughly).
        dragY += -dy * dist * 0.0016 * Math.tan(FOV / 2) * 2;
        const local = worldPositionToLocal(gateway.activeWorld, dragId!, [
          dragWorldPos[0],
          snap(dragY, 0.5, ctrl),
          dragWorldPos[2],
        ]);
        applyLive({ x: local[0], y: local[1], z: local[2] });
      } else {
        const g = rayPlaneY(origin, dir, dragY);
        if (g) {
          const local = worldPositionToLocal(gateway.activeWorld, dragId!, [
            snap(g[0] + grabOffset[0], 0.5, ctrl),
            dragY,
            snap(g[2] + grabOffset[2], 0.5, ctrl),
          ]);
          applyLive({ x: local[0], y: local[1], z: local[2] });
        }
      }
      updateGizmo();
    }
  }

  function onUp(): void {
    // Capture the ending gesture mode BEFORE reset so we can record a camera-nav
    // gesture as one session op (D-12 path A). Only orbit/pan/zoom are camera
    // navigation; drag/axisDrag are entity edits (already document ops).
    const endedMode = mode;
    // Close the gizmo document-continuous op (D-9). If a lifecycle handle is open
    // (drag produced live changes), commit lands the whole drag as ONE undoable
    // setComponent whose recorded pose = the final accumulated update (gateway
    // lastCmd). A pointerup with no live change (plain click) opened no handle, so
    // there is nothing to commit — no empty command enters the ledger.
    if (dragHandle !== null) {
      gateway.commit(dragHandle);
      dragHandle = null;
    }
    mode = 'none'; dragId = null; dragWorld = undefined; livePatch = {}; dragPlane = null;
    // D-12 path A (S13 / AC-30): a completed camera-nav gesture records ONE
    // cameraOrbit session op carrying the gesture-end pose. Mid-frame poses stayed
    // on the facade direct write (applyCamera) — out of the ledger (OOS-4). A
    // cancelled/aborted gesture never reaches onUp so emits nothing (0 records —
    // no "half record" in the structure). AC-30 gates orbit; pan/zoom ride the
    // same op as best-effort (same pose payload, not an AC assertion).
    if (endedMode === 'orbit' || endedMode === 'pan' || endedMode === 'zoom') {
      gateway.dispatch({
        kind: 'cameraOrbit',
        target: [target[0], target[1], target[2]],
        yaw, pitch, dist,
      }, 'human');
    } else if (endedMode === 'fly') {
      // T2d + T6a: FLY gesture ended. Stop the rAF loop, reconstruct a reasonable
      // orbit target from the fly-end pose (so a subsequent MMB/Alt+LMB gesture
      // orbits smoothly around the point ahead of the camera), then record ONE
      // cameraFly session op — ledger +1, no undo growth. AI can reproduce this
      // pose via gateway.dispatch({kind:'cameraFly', pos, yaw, pitch}, 'ai').
      if (flyRAF !== 0) { cancelAnimationFrame(flyRAF); flyRAF = 0; }
      const orb = flyToOrbit({ pos: camPos, yaw, pitch }, dist);
      target = orb.target; dist = orb.dist;
      gateway.dispatch({
        kind: 'cameraFly',
        pos: [camPos[0], camPos[1], camPos[2]],
        yaw, pitch,
      }, 'human');
    }
    // Stop the Inspector preview (transient op); the panel now reads the committed doc.
    gateway.dispatch({ kind: 'setFieldPreview', id: null });
    updateGizmo();
  }

  function onWheel(e: WheelEvent): void {
    if (!inCanvas(e.target)) return;
    if (inputToGame()) return;
    e.preventDefault();
    if (mode === 'fly') {
      // T5: in-flight scroll adjusts move speed (UE5 standard).
      //   wheel up  (deltaY < 0) → speed up
      //   wheel dn  (deltaY > 0) → slow down
      flySpeed = applyFlyWheelSpeed(flySpeed, e.deltaY > 0 ? -1 : 1);
      return;
    }
    dist = clampDist(dist * (e.deltaY > 0 ? 1.1 : 0.9));
    applyCamera();
  }

  function onContext(e: MouseEvent): void {
    if (inCanvas(e.target)) e.preventDefault();
  }

  /** Re-aim to the default character framing: target chest-height, ~4.5m back,
   *  slight downward tilt — matches the recenter view intent which grounds the
   *  character at the origin (~1.9m tall). */
  function resetCamera(): void {
    target = [0, 1, 0];
    yaw = 0.6;
    pitch = -0.3;
    dist = 4.5;
    applyCamera();
  }

  /** Frame the current selection: center the orbit target on it + fit distance. */
  function frameSelection(): void {
    const sel = getSelection();
    const t = sel !== null ? readWorldTransform(gateway.activeWorld, sel) : undefined;
    if (!t) return;
    const { center, half } = entityBox(t);
    target = center;
    dist = Math.max(4, Math.max(half[0], half[1], half[2]) * 4);
    applyCamera();
  }

  // W / E / R switch gizmo mode (move / rotate / scale); F frames the selection.
  // Skipped while typing. NOTE (keyboard-router convergence M4 T4-5): Delete /
  // Backspace / F2 / Ctrl+D / Ctrl+A / G are intentionally NOT handled here — they
  // live in the single global-shortcuts router (interface submodule). This keeps
  // exactly ONE global keydown listener (G-1 / AC-A1) and routes every edit gesture
  // through the one gateway door.
  function onKey(e: KeyboardEvent): void {
    // T2b: mirror fly keys in the existing global keydown hook (G-1 allows no
    // second window keydown listener). flyTick only runs in fly mode, so tracking
    // here does not move the camera while typing in a field.
    const k = e.key.toLowerCase();
    if (k === 'w' || k === 'a' || k === 's' || k === 'd' || k === 'q' || k === 'e') {
      keyState[k] = true;
    }
    const el = e.target as HTMLElement | null;
    const tag = el?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
    if (inputToGame()) return; // play·game: W/E/R/F gizmo shortcuts yield to the game
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // T2 risk-1: in fly mode WASD/QE drive movement — do NOT hijack W/E/R for
    // gizmo mode switching. Frame (F) is likewise ambiguous while flying.
    if (mode === 'fly') return;
    if (k === 'w') gateway.dispatch({ kind: 'setGizmoMode', mode: 'translate' });
    else if (k === 'e') gateway.dispatch({ kind: 'setGizmoMode', mode: 'rotate' });
    else if (k === 'r') gateway.dispatch({ kind: 'setGizmoMode', mode: 'scale' });
    else if (k === 'f') gateway.dispatch({ kind: 'requestFrame' });
  }
  function onKeyUp(e: KeyboardEvent): void {
    const k = e.key.toLowerCase();
    if (k === 'w' || k === 'a' || k === 's' || k === 'd' || k === 'q' || k === 'e') {
      keyState[k] = false;
    }
  }
  // Guard against sticky keys when tab loses focus mid-flight (release all).
  function onBlur(): void {
    for (const k in keyState) keyState[k] = false;
  }

  // double-click an entity → select + frame it.
  function onDblClick(e: MouseEvent): void {
    if (!inCanvas(e.target)) return;
    if (inputToGame()) return;
    const hit = pick(e.clientX, e.clientY);
    if (hit !== null) { gateway.dispatch({ kind: 'setSelection', id: hit }); gateway.dispatch({ kind: 'requestFrame' }); }
  }

  canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContext);
  window.addEventListener('keydown', onKey);
  // T2b: keyup/blur release fly keys tracked by onKey above.
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  canvas.addEventListener('dblclick', onDblClick);
  // the gizmo follows the selection (Hierarchy click, viewport pick, AI, …) and
  // re-tints when the mode changes; param gizmos also track doc edits (e.g. the
  // Inspector changing a light's range or a camera's fov).
  const refreshGizmos = (): void => { updateGizmo(); updateParamGizmo(); };

// Display visibility bus (w23, D-5): re-gate gizmos when display toggles so
// display='game' immediately hides / 'scene' immediately restores visual aides.
onDisplayModeChange(() => refreshGizmos());
  // The gizmos depend ONLY on the selected entity's own components (updateGizmo
  // reads its local Transform; updateParamGizmo reads its Light/Camera). So an
  // edit to any OTHER entity can't move them — skip the refresh by tracking a
  // signature of just the selected entity (cheap: one entity, not the whole doc).
  const selSig = (): string | null => {
    const sel = getSelection();
    if (sel === null) return null;
    // M7-a: signature the selected entity's components read from the world (SSOT)
    // instead of the deleted doc.entities mirror. Empty dict = entity gone.
    const comps = entComponents(gateway.activeWorld, sel);
    return Object.keys(comps).length > 0 ? JSON.stringify(comps) : '\u2205'; // '∅' = selected entity gone
  };
  let lastSelSig = selSig();
  const unsubSel = onSelectionChange(() => { lastSelSig = selSig(); refreshGizmos(); });
  const unsubMode = onGizmoModeChange(updateGizmo);
  const unsubDoc = gateway.subscribe(() => {
    const sig = selSig();
    if (sig === lastSelSig) return; // selected entity unchanged → gizmos unaffected
    lastSelSig = sig;
    refreshGizmos();
  });
  applyCamera(); // also paints the gizmo if something is already selected

  return {
    dispose() {
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContext);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      canvas.removeEventListener('dblclick', onDblClick);
      if (flyRAF !== 0) { cancelAnimationFrame(flyRAF); flyRAF = 0; }
      unsubSel();
      unsubMode();
      unsubDoc();
      unregCameraOrbit();
      unregCameraFly();
      unregCameraTeleport();
      unregCameraLookAt();
      unregRequestFrame();
      despawnHandles();
      despawnParam();
    },
    refresh: applyCamera,
    resetCamera,
  };
}
