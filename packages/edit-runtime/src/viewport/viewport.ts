// Viewport interaction — the "human directly manipulates the scene" half of
// Edit mode: camera navigation, picking, gizmo, and drag-to-move.
//
// Camera bindings (UE5 editor style):
//   RMB (hold)     = FLY MODE (free-look + WASD/QE + scroll speed)
//   MMB drag       = pan (no modifier needed)
//   Alt + LMB      = orbit (tumble around target)
//   Alt + RMB      = zoom / dolly
//   scroll wheel   = zoom (outside fly) / speed adj (inside fly)
//   LMB            = select / gizmo
//
// Click-to-pick: left-click an entity → select (ray vs per-entity AABB);
// left-click empty = deselect.
//
// Drag-to-move: left-drag a selected entity → slide on the ground (XZ); hold
// Shift → move vertically (Y). Live via world.set (no doc churn); committed
// as ONE undoable setComponent on release.
//
// Camera math uses qCam = yaw·[0,1,0] × pitch·[1,0,0]; forward = qCam·[0,0,-1].
// Pure geometry (ray/AABB/plane) is factored into sibling modules and unit-
// tested; only the wiring depends on the (untyped) engine.
import {
  Transform,
  ChildOf,
  Camera,
  perspective,
  TONEMAP_REINHARD_EXTENDED,
  quat,
} from '@forgeax/engine-runtime';
// engine #650 (Tier-2 decomposition) moved pick/PickError into @forgeax/engine-picking.
import { pick as enginePick, PickError } from '@forgeax/engine-picking';
import type { World, EntityHandle } from '@forgeax/engine-ecs';

// Pure geometry / camera math / gizmo geometry live in sibling modules
// (viewport-ray, viewport-camera, viewport-gizmo-geometry). The interactive
// gizmo pools (viewport-gizmo, viewport-param-gizmo), camera session-op
// appliers (viewport-camera-appliers), and Transform read adapters
// (viewport-entity-read) also live outside — this file is now the DI factory
// (createViewport) + a re-export barrel + the interaction state machine
// (fly/orbit tick, pointer/keyboard handlers, drag lifecycle).
export { type Vec3, num, ndcFromClient, rayDirection, rayAABB, rayPlaneY, closestAxisT, rayPlane, orthoBasis, angleOnAxis, entityBox } from './viewport-ray';
export { deriveInputTarget, clampPitch, clampDist, advanceOrbit, computeOrbitCamera, clampFlySpeed, applyFlyWheelSpeed, advanceFly, advanceFlyLook, computeFlyCamera, orbitToFly, flyToOrbit, FLY_SPEED_DEFAULT, FLY_SPEED_MIN, FLY_SPEED_MAX, FLY_SPEED_STEP, type RunMode, type DisplayMode, type InputTarget, type ControlOwner, type OrbitState, type OrbitCameraResult, type FlyState, type FlyInput, type Quat } from './viewport-camera';
import { type Vec3, num, ndcFromClient, rayDirection, rayAABB, rayPlaneY, closestAxisT, rayPlane, angleOnAxis, entityBox } from './viewport-ray';
import { clampDist, advanceOrbit, computeOrbitCamera, advanceFly, advanceFlyLook, computeFlyCamera, applyFlyWheelSpeed, flyToOrbit, FLY_SPEED_DEFAULT, type InputTarget, type FlyInput } from './viewport-camera';
import { registerCameraAppliers } from './viewport-camera-appliers';
import { createGizmoPool } from './viewport-gizmo';
import { createParamGizmo } from './viewport-param-gizmo';
import { AXES, DEG2RAD, PLANES, type PlaneHandle } from './viewport-gizmo-geometry';
import { readLocalTransform, readWorldTransform, worldPositionToLocal, isEntHidden, type EditorTransform } from './viewport-entity-read';

import type { OpHandle, EngineFacade } from '@forgeax/editor-core';
import { worldEntityHandles, entExists, entComponents } from '@forgeax/editor-core';
// M3 (AC-03, plan-strategy §2 D-9): selection / field-preview / gizmo-mode go
// through the one gateway door — gateway.dispatch({ kind, … }) — and the gizmo DRAG
// (a document continuous op) uses the gateway lifecycle begin/update*/commit so
// the whole multi-frame drag lands as ONE undoable command. Direct store setters
// (setSelection/setFieldPreview/setGizmoMode) are gone. Camera orbit stays a
// direct world.set (see the note at applyCamera).
import { gateway, getGizmoMode, getSelection, onGizmoModeChange, onSelectionChange } from '@forgeax/editor-core';
// M4: EngineSync import removed — sync.ts deleted (projection layer collapse).
import { isAuxVisible, onDisplayModeChange } from './display-bus';

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

  // ── camera session-op appliers (cameraOrbit / cameraFly / cameraTeleport /
  //    cameraLookAt / requestFrame) — extracted to viewport-camera-appliers.ts.
  // Mid-frame orbit/fly stays on the direct facade path (applyCamera / flyTick);
  // gesture-END and AI-issued kinds route here so the camera pose lands as ONE
  // ledger record (D-12 path A, session domain: no undo, no lifecycle slot).
  const unregCameraAppliers = registerCameraAppliers({
    editorEngine, camera,
    getPose: () => ({ target, yaw, pitch, dist, camPos, fwd, rgt, upv }),
    setPose: (p) => {
      target = p.target; yaw = p.yaw; pitch = p.pitch; dist = p.dist;
      camPos = p.camPos; fwd = p.fwd; rgt = p.rgt; upv = p.upv;
    },
    frameSelection: () => frameSelection(),
  });

  // ── gizmo pools ────────────────────────────────────────────────────────────
  // Interactive selection gizmo (3 axis handles, shape follows mode) lives in
  // viewport-gizmo.ts; parameter gizmos (light range/spot cone, camera frustum)
  // in viewport-param-gizmo.ts. Both spawn on editorEngine (editorWorld — AC-01)
  // and READ the selected entity from gateway.activeWorld (super moves values
  // across worlds, never identity). The interactive pool's spawnHandleCube is
  // shared with the param gizmo (both are dot-clouds of HANDLE_CUBE).
  const gizmoSelWorldT = (): EditorTransform | undefined => {
    const sel = getSelection();
    return sel !== null ? readWorldTransform(gateway.activeWorld, sel) : undefined;
  };
  const gizmoPool = createGizmoPool({
    editorEngine,
    getSelection,
    getGizmoMode,
    getSelectionWorldTransform: gizmoSelWorldT,
    isAuxVisible,
    getDist: () => dist,
  });
  const paramGizmo = createParamGizmo({
    editorEngine,
    spawnHandleCube: gizmoPool.spawnHandleCube,
    getSelection,
    getSelectionComponents: () => {
      const sel = getSelection();
      return sel !== null ? entComponents(gateway.activeWorld, sel) : undefined;
    },
    getSelectionWorldTransform: gizmoSelWorldT,
    isAuxVisible,
    getDist: () => dist,
    getAspect: aspect,
  });
  const updateGizmo = (): void => gizmoPool.update();
  const updateParamGizmo = (): void => paramGizmo.update();
  const hitGizmo = (origin: Vec3, dir: Vec3): number | null => gizmoPool.hit(origin, dir);

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
      unregCameraAppliers();
      gizmoPool.dispose();
      paramGizmo.dispose();
    },
    refresh: applyCamera,
    resetCamera,
  };
}
