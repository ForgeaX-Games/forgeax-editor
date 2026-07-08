// Viewport interaction — the "human directly manipulates the scene" half of Edit
// mode (design EDITOR-MODE P1: viewport navigation / picking / gizmo). The forgeax port shipped
// only the data model + Hierarchy + Inspector + doc→world render, leaving the
// canvas inert; this module adds:
//   • orbit camera   — Blender DEFAULT: MMB = orbit · Shift+MMB = pan ·
//                      Ctrl+MMB = zoom · wheel = zoom. Mac trackpad ("emulate
//                      3-button mouse"): Alt+LMB orbit / Shift+Alt+LMB pan /
//                      Ctrl+Alt+LMB zoom. Left is reserved for select/gizmo so a
//                      large object filling the view never blocks orbiting.
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
  HANDLE_CUBE,
  pick as enginePick,
  PickError,
} from '@forgeax/engine-runtime';
import type { World, EntityHandle, Handle } from '@forgeax/engine-ecs';
// engine #610 (Tier-1 decomposition) moved procedural mesh builders into the
// @forgeax/engine-geometry leaf package.
import { meshFromInterleaved } from '@forgeax/engine-geometry';
import type { Vec3 as EngineVec3 } from '@forgeax/engine-math';
import { vec3 } from '@forgeax/engine-math';

// M2 extraction: pure geometry lives in viewport-ray.ts; orbit math in viewport-camera.ts.
// viewport.ts is now a DI factory (createViewport) + re-export barrel (plan-strategy D-5).
export { type Vec3, num, ndcFromClient, rayDirection, rayAABB, rayPlaneY, closestAxisT, rayPlane, orthoBasis, angleOnAxis, entityBox } from './viewport-ray';
export { deriveInputTarget, clampPitch, clampDist, advanceOrbit, computeOrbitCamera, type RunMode, type DisplayMode, type InputTarget, type OrbitState, type OrbitCameraResult, type Quat } from './viewport-camera';
import { type Vec3, num, ndcFromClient, rayDirection, rayAABB, rayPlaneY, closestAxisT, rayPlane, orthoBasis, angleOnAxis, entityBox } from './viewport-ray';
import { clampDist, advanceOrbit, computeOrbitCamera, type InputTarget } from './viewport-camera';

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
// (posX/posY/posZ + quatX/Y/Z/W + scaleX/Y/Z). The viewport gizmo/drag math is
// written against the editor euler-degree shape (x/y/z + rotX/rotY/rotZ), so read
// once through this adapter and convert quat→euler HERE (euler-quat.ts is the SSOT
// for that conversion — AGENTS.md #6). Returns undefined for organizational nodes
// (no Transform) so callers keep their "nothing to gizmo/pick" fast-exit.
type EditorTransform = {
  x: number; y: number; z: number;
  rotX: number; rotY: number; rotZ: number;
  scaleX: number; scaleY: number; scaleZ: number;
};
function readEntTransform(world: World, handle: EntityHandle): EditorTransform | undefined {
  const r = entComponent(world, handle, 'Transform');
  if (!r.ok) return undefined;
  const t = r.value;
  const n = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const e = quatToEuler(n(t.quatX, 0), n(t.quatY, 0), n(t.quatZ, 0), n(t.quatW, 1));
  return {
    x: n(t.posX, 0), y: n(t.posY, 0), z: n(t.posZ, 0),
    rotX: e.rotX, rotY: e.rotY, rotZ: e.rotZ,
    scaleX: n(t.scaleX, 1), scaleY: n(t.scaleY, 1), scaleZ: n(t.scaleZ, 1),
  };
}
// EditorHidden is an editor-only marker; the entComponents walk surfaces it from
// the active world.
function isEntHidden(world: World, handle: EntityHandle): boolean {
  return 'EditorHidden' in entComponents(world, handle);
}

const DEG2RAD = Math.PI / 180;

// ── factory-local buffer (used by updateParamGizmo) ────────────────────────
// Single reusable Float32Array for engine vec3 operations within the factory.
// All pure-geometry functions now use their own buffer in viewport-ray.ts.
const _v3 = new Float32Array(3) as EngineVec3;

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
  assets?: AssetsLike;   // legacy slot — gizmo handle materials now mint via engine.allocSharedRef
  camera: EntityHandle;  // the editor camera entity (engine.spawn().unwrap() handle)
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

export function createViewport({ canvas, engine, camera, initialOrbit, getInputTarget }: ViewportDeps): Viewport {
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
    // M3 t17 (S4 / AC-05): the orbit camera's per-frame Transform write goes
    // through the injected EngineFacade (ctx.engine proxy), not the raw world.
    // This is the ONE surgery point that touches the render path — same-name shape
    // method so the pose write is byte-identical, only now trace-visible (AC-06
    // no visual regression; facade is a pure forwarding layer).
    engine.set(camera, Transform, {
      posX: camPos[0], posY: camPos[1], posZ: camPos[2],
      quatX: r.qCam[0], quatY: r.qCam[1], quatZ: r.qCam[2], quatW: r.qCam[3],
      scaleX: 1, scaleY: 1, scaleZ: 1,
    });
    // tonemap must stay active so the HDR SkyboxBackground pass draws (this set
    // replaces the Camera component each frame, so tonemap must be re-applied).
    // clearR/G/B too: on WebKit/WKWebView (the desktop app) the cubemap skybox
    // can't render, so without a clear color the Edit viewport is pure black —
    // a neutral studio blue reads as sky. perspective() carries clearR/G/B=0, so
    // it MUST be re-applied here (this set replaces the whole Camera each frame),
    // not just at spawn. On Chromium the cubemap skybox draws over it.
    engine.set(camera, Camera, { ...perspective({ fov: FOV, aspect: aspect(), near: 0.05, far: 2000 }), tonemap: TONEMAP_REINHARD_EXTENDED, clearR: 0.42, clearG: 0.55, clearB: 0.78 });
    updateGizmo();
    updateParamGizmo();
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
  const unregCameraOrbit = registerSessionApplier(
    'cameraOrbit',
    (op, ctx): { ok: true } | { ok: false; error: { code: 'SET_FAILED'; hint: string } } => {
      const o = op as unknown as {
        target?: [number, number, number]; yaw?: number; pitch?: number; dist?: number;
      };
      const eng = ctx?.engine;
      if (!eng) {
        // No ctx.engine means the executor did not hand us the proxy — fail loud
        // rather than silently no-op (charter P3). Should never happen post-t20d.
        return { ok: false, error: { code: 'SET_FAILED', hint: 'cameraOrbit applier received no ctx.engine' } };
      }
      const tgt: Vec3 = o.target ? [o.target[0], o.target[1], o.target[2]] : [...target];
      const r = computeOrbitCamera(tgt, o.yaw ?? yaw, o.pitch ?? pitch, o.dist ?? dist);
      eng.set(camera, Transform, {
        posX: r.camPos[0], posY: r.camPos[1], posZ: r.camPos[2],
        quatX: r.qCam[0], quatY: r.qCam[1], quatZ: r.qCam[2], quatW: r.qCam[3],
        scaleX: 1, scaleY: 1, scaleZ: 1,
      });
      return { ok: true };
    },
    { title: 'Orbit camera' },
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
  const AXES: { axis: Vec3; color: [number, number, number] }[] = [
    { axis: [1, 0, 0], color: [1.0, 0.25, 0.2] },  // X red
    { axis: [0, 1, 0], color: [0.3, 1.0, 0.35] },  // Y green
    { axis: [0, 0, 1], color: [0.3, 0.55, 1.0] },  // Z blue
  ];
  // Plane handles (translate only): drag two axes at once. ax/ay index into x/y/z;
  // `normal` is the third axis (the plane's normal, for ray∩plane drag).
  const PLANES: { ax: number; ay: number; normal: Vec3; mat: number }[] = [
    { ax: 0, ay: 1, normal: [0, 0, 1], mat: 2 }, // XY plane (Z-normal, blue tint)
    { ax: 1, ay: 2, normal: [1, 0, 0], mat: 0 }, // YZ plane (X-normal, red tint)
    { ax: 0, ay: 2, normal: [0, 1, 0], mat: 1 }, // XZ plane (Y-normal, green tint)
  ];
  const RING_SEG = 24; // cube segments per ring
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
    const SEG = 16;
    const v: number[] = [];
    const push = (x: number, y: number, z: number): void => { v.push(x, y, z, 0, 1, 0, 0, 0); };
    push(0, 1, 0);  // 0: apex
    push(0, 0, 0);  // 1: base center
    for (let i = 0; i < SEG; i++) { const t = (i / SEG) * Math.PI * 2; push(Math.cos(t), 0, Math.sin(t)); }
    const idx: number[] = [];
    for (let i = 0; i < SEG; i++) {
      const a = 2 + i, b = 2 + ((i + 1) % SEG);
      idx.push(0, a, b);  // side face
      idx.push(1, b, a);  // base cap
    }
    coneMesh = engine.allocSharedRef('MeshAsset', meshFromInterleaved(new Float32Array(v), new Uint16Array(idx)));
    return coneMesh;
  }
  // Quaternion that rotates the cone's local +Y to point down each world axis.
  const TIP_QUAT: [number, number, number, number][] = [
    [0, 0, -0.70710678, 0.70710678], // X: +Y → +X
    [0, 0, 0, 1],                     // Y: identity
    [0.70710678, 0, 0, 0.70710678],   // Z: +Y → +Z
  ];

  function ensureMats(): Handle<'MaterialAsset', 'shared'>[] {
    if (!gizmoMats) gizmoMats = AXES.map((a) => {
      // Always-on-top gizmo: draw in the Overlay queue (4000, drawn last) with
      // depthCompare:'always' + no depth write, so the handles are never hidden
      // behind the (possibly huge) object they're anchored on.
      const base = Materials.unlit([a.color[0], a.color[1], a.color[2], 1]) as {
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
      return engine.allocSharedRef('MaterialAsset', mat);
    });
    return gizmoMats;
  }
  function spawnHandleMesh(
    mesh: Handle<'MeshAsset', 'shared'>,
    material: Handle<'MaterialAsset', 'shared'>,
  ): EntityHandle {
    return engine.spawn(
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
    for (const e of barEnts) { try { engine.despawn(e); } catch { /* gone */ } }
    for (const e of tipEnts) { try { engine.despawn(e); } catch { /* gone */ } }
    for (const e of planeEnts) { try { engine.despawn(e); } catch { /* gone */ } }
    for (const e of ringEnts) { try { engine.despawn(e); } catch { /* gone */ } }
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
      engine.set(barEnts[i]!, Transform, { posX: hc[0], posY: hc[1], posZ: hc[2], scaleX: sx, scaleY: sy, scaleZ: sz });
      if (hasTips) {
        // Cone base sits at the bar's outer end, apex pointing further out along
        // the axis. scaleY is the cone's local height (→ length after the +Y→axis
        // rotation); scaleX/Z are the base radius.
        const base: Vec3 = [center[0] + a.axis[0] * len, center[1] + a.axis[1] * len, center[2] + a.axis[2] * len];
        const q = TIP_QUAT[i]!;
        engine.set(tipEnts[i]!, Transform, {
          posX: base[0], posY: base[1], posZ: base[2],
          scaleX: tipRad, scaleY: tipLen, scaleZ: tipRad,
          quatX: q[0], quatY: q[1], quatZ: q[2], quatW: q[3],
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
      engine.set(planeEnts[i]!, Transform, { posX: hc[0], posY: hc[1], posZ: hc[2], scaleX: s[0], scaleY: s[1], scaleZ: s[2] });
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
        engine.set(ringEnts[i * RING_SEG + j]!, Transform, { posX: p[0], posY: p[1], posZ: p[2], scaleX: seg, scaleY: seg, scaleZ: seg });
      }
    }
  }
  /** Re-place the gizmo on the current selection (or hide it). Sized by camera
   *  distance so handles stay grabbable at any zoom; shape switches with the mode. */
  function updateGizmo(): void {
    // Display gate (w23, D-5): display='game' → hide ALL auxiliary entities.
    if (!isAuxVisible()) { despawnHandles(); return; }
    const sel = getSelection();
    // During a live drag the DOC isn't touched (we only world.set a preview), so
    // for the entity being dragged read its LIVE transform (dragOrig + livePatch)
    // — otherwise the gizmo lags at the pre-drag position until release.
    const live = sel !== null && dragId === sel ? { ...dragOrig, ...livePatch } : undefined;
    const t = live ?? (sel !== null ? readEntTransform(gateway.activeWorld, sel) : undefined);
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
    if (!paramMat) paramMat = engine.allocSharedRef('MaterialAsset', Materials.unlit([1.0, 0.82, 0.25, 1]));
    return paramMat;
  }
  function despawnParam(): void {
    for (const e of paramEnts) { try { engine.despawn(e); } catch { /* gone */ } }
    paramEnts = [];
  }
  function placeDots(points: Vec3[], size: number): void {
    if (points.length === 0) { despawnParam(); return; }
    const mat = ensureParamMat();
    while (paramEnts.length < points.length) paramEnts.push(spawnHandleCube(mat));
    while (paramEnts.length > points.length) { const e = paramEnts.pop()!; try { engine.despawn(e); } catch { /* gone */ } }
    points.forEach((p, i) => engine.set(paramEnts[i]!, Transform, { posX: p[0], posY: p[1], posZ: p[2], scaleX: size, scaleY: size, scaleZ: size }));
  }
  const addSeg = (out: Vec3[], a: Vec3, b: Vec3, n = 10): void => {
    for (let i = 0; i <= n; i++) { const k = i / n; out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]); }
  };
  const circlePts = (center: Vec3, u: Vec3, v: Vec3, r: number, n = 40): Vec3[] => {
    const o: Vec3[] = [];
    for (let j = 0; j < n; j++) { const th = (j / n) * Math.PI * 2, c = Math.cos(th) * r, s = Math.sin(th) * r; o.push([center[0] + u[0] * c + v[0] * s, center[1] + u[1] * c + v[1] * s, center[2] + u[2] * c + v[2] * s]); }
    return o;
  };
  function forwardOf(t?: Record<string, number>): Vec3 {
    const q = quat.create();
    quat.fromEuler(q, num(t?.rotX, 0) * DEG2RAD, num(t?.rotY, 0) * DEG2RAD, num(t?.rotZ, 0) * DEG2RAD, 'XYZ');
    const o = new Float32Array(3) as EngineVec3; quat.transformVec3(o, q, [0, 0, -1] as unknown as EngineVec3);
    return [o[0]!, o[1]!, o[2]!];
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
    const t = sel !== null ? readEntTransform(gateway.activeWorld, sel) : undefined;
    const center: Vec3 = [num(t?.x, 0), num(t?.y, 0), num(t?.z, 0)];
    const light = comps.Light as Record<string, unknown> | undefined;
    const cam = comps.Camera as Record<string, unknown> | undefined;
    const pts: Vec3[] = [];
    if (light) {
      const type = (light.type as string) ?? 'point';
      if (type === 'directional') {
        vec3.normalize(_v3, [num(light.directionX as number, -0.4), num(light.directionY as number, -1), num(light.directionZ as number, -0.3)]);
        const dir: Vec3 = [_v3[0]!, _v3[1]!, _v3[2]!];
        const len = Math.max(2, dist * 0.18);
        const tip: Vec3 = [center[0] + dir[0] * len, center[1] + dir[1] * len, center[2] + dir[2] * len];
        addSeg(pts, center, tip, 16);
        const [u, v] = orthoBasis(dir);
        const back = len * 0.18;
        for (const s of [u, v, [-u[0], -u[1], -u[2]] as Vec3, [-v[0], -v[1], -v[2]] as Vec3]) {
          addSeg(pts, tip, [tip[0] - dir[0] * back + s[0] * back, tip[1] - dir[1] * back + s[1] * back, tip[2] - dir[2] * back + s[2] * back], 5);
        }
      } else if (type === 'spot') {
        const range = num(light.range as number, 0) || 6;
        const half = num(light.spotAngle as number, 30) * DEG2RAD;
        const fwd = forwardOf(t);
        const [u, v] = orthoBasis(fwd);
        const baseC: Vec3 = [center[0] + fwd[0] * range, center[1] + fwd[1] * range, center[2] + fwd[2] * range];
        const br = Math.tan(half) * range;
        pts.push(...circlePts(baseC, u, v, br, 36));
        for (let j = 0; j < 4; j++) { const th = (j / 4) * Math.PI * 2, c = Math.cos(th) * br, s = Math.sin(th) * br; addSeg(pts, center, [baseC[0] + u[0] * c + v[0] * s, baseC[1] + u[1] * c + v[1] * s, baseC[2] + u[2] * c + v[2] * s], 10); }
      } else { // point (or unknown) → range sphere = 3 axis rings
        const range = num(light.range as number, 0) || 3;
        for (const a of AXES) { const [u, v] = orthoBasis(a.axis); pts.push(...circlePts(center, u, v, range, 36)); }
      }
    }
    if (cam) {
      const fov = num(cam.fov as number, 60) * DEG2RAD;
      const near = num(cam.near as number, 0.1);
      const far = Math.min(num(cam.far as number, 1000), dist * 4 + 30); // clamp so it stays on-screen
      const fwd = forwardOf(t);
      const [right, up] = orthoBasis(fwd);
      const rect = (depth: number): Vec3[] => {
        const hh = Math.tan(fov / 2) * depth, hw = hh * (aspect() || 1);
        const cC: Vec3 = [center[0] + fwd[0] * depth, center[1] + fwd[1] * depth, center[2] + fwd[2] * depth];
        const corner = (sx: number, sy: number): Vec3 => [cC[0] + right[0] * hw * sx + up[0] * hh * sy, cC[1] + right[1] * hw * sx + up[1] * hh * sy, cC[2] + right[2] * hw * sx + up[2] * hh * sy];
        return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
      };
      const n4 = rect(near), f4 = rect(far);
      for (let i = 0; i < 4; i++) { addSeg(pts, n4[i]!, n4[(i + 1) % 4]!, 6); addSeg(pts, f4[i]!, f4[(i + 1) % 4]!, 8); addSeg(pts, n4[i]!, f4[i]!, 10); }
    }
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

    // 1) Engine pick (precise, mesh-level AABB + world matrix)
    try {
      const hit = enginePick(w, camera as unknown as EntityHandle, sx, sy, r.width, r.height);
      if (hit) {
        const resolved = resolveEditorEntity(activeWorld, hit.entity as EntityHandle);
        if (resolved !== null) return resolved;
      }
    } catch (e) {
      if (!(e instanceof PickError)) throw e;
    }

    // 2) Fallback: editor-level Transform-scale AABB sweep.
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
      const t = readEntTransform(activeWorld, id);
      if (!t) continue;
      const { center, half } = entityBox(t);
      const hit = rayAABB(origin, dir, center, half);
      if (hit !== null && hit < bestT) { bestT = hit; best = id; }
    }
    return best;
  }

  // ── pointer interaction ──
  type Mode = 'none' | 'orbit' | 'pan' | 'zoom' | 'pendDrag' | 'drag' | 'axisDrag';
  let mode: Mode = 'none';
  let lastX = 0, lastY = 0, downX = 0, downY = 0;
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
  let dragPlane: { ax: number; ay: number; normal: Vec3; mat: number } | null = null;
  let planeGrab: Vec3 = [0, 0, 0];
  // the changed Transform fields, committed as ONE command on release.
  let livePatch: Record<string, number> = {};
  const qd = quat.create();

  /** Convert an editor-shape Transform (x/y/z + rotX/rotY/rotZ + scale) into the
   *  engine-native POD (posX/posY/posZ + quatX/Y/Z/W + scale). M7-a: the world is
   *  the SSOT — both the live preview (world.set) and the commit (setComponent →
   *  document.ts w.set) must write engine field names, not the editor euler shape.
   *  euler→quat uses the XYZ-order convention (euler-quat.ts SSOT, AGENTS.md #6). */
  const toEnginePatch = (m: Record<string, number>): Record<string, number> => {
    const data: Record<string, number> = {
      posX: num(m.x, 0), posY: num(m.y, 0), posZ: num(m.z, 0),
      scaleX: num(m.scaleX, 1), scaleY: num(m.scaleY, 1), scaleZ: num(m.scaleZ, 1),
    };
    const rx = num(m.rotX, 0), ry = num(m.rotY, 0), rz = num(m.rotZ, 0);
    if (rx || ry || rz) {
      quat.fromEuler(qd, rx * DEG2RAD, ry * DEG2RAD, rz * DEG2RAD, 'XYZ');
      data.quatX = qd[0]!; data.quatY = qd[1]!; data.quatZ = qd[2]!; data.quatW = qd[3]!;
    } else { data.quatX = 0; data.quatY = 0; data.quatZ = 0; data.quatW = 1; }
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

  // A click is "in the viewport" unless it landed on one of the docked panels or
  // toolbar. The canvas is behind the #ui overlay, so e.target is usually a DOM
  // element from the overlay — filtering panels is more robust than matching canvas.
  // Selectors updated to match current DockShell (dockview-based) + keep-alive layer.
  const overPanel = (t: EventTarget | null): boolean =>
    !!(t as HTMLElement | null)?.closest?.('.fx-dockshell, .fx-dockwrap, .fx-dock-popout, .ed-toolbar');

  function onDown(e: PointerEvent): void {
    if (overPanel(e.target)) return; // let panels handle their own clicks
    if (inputToGame()) return; // play·game: input belongs to the game — let it pass through to canvas
    lastX = downX = e.clientX; lastY = downY = e.clientY;
    // Blender DEFAULT navigation, aligned 1:1:
    //   MMB = orbit · Shift+MMB = pan · Ctrl+MMB = zoom · wheel = zoom · LMB = select.
    //   Left is freed entirely for selection + gizmo, so a large object filling
    //   the view never blocks orbiting (orbit lives on the middle button).
    const navMode = (): Mode => (e.shiftKey ? 'pan' : (e.ctrlKey || e.metaKey) ? 'zoom' : 'orbit');
    if (e.button === 1) { mode = navMode(); e.preventDefault(); return; }
    // RMB is Blender's context menu — the viewport has none, so just swallow it.
    if (e.button === 2) { e.preventDefault(); return; }
    if (e.button !== 0) return;
    // Mac trackpad — Blender "Emulate 3-Button Mouse": Alt+LMB = orbit,
    // Shift+Alt+LMB = pan, Ctrl+Alt+LMB = zoom.
    if (e.altKey) { mode = navMode(); e.preventDefault(); return; }
    const { origin, dir } = rayAt(e.clientX, e.clientY);
    // gizmo handles take priority over entity/orbit picking.
    const sel = getSelection();
    const h = sel !== null ? hitGizmo(origin, dir) : null;
    if (h !== null && sel !== null) {
      dragId = sel;
// M4: worldEntityFor removed — entity IDs are directly world entities.
      dragWorld = sel as unknown as EntityHandle;
      // M7-a: read the grab-time Transform from the world (doc.entities gone).
      dragOrig = { ...(readEntTransform(gateway.activeWorld, sel) ?? {}) };
      axisStart = [num(dragOrig.x, 0), num(dragOrig.y, 0), num(dragOrig.z, 0)];
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
      dragOrig = { ...(readEntTransform(gateway.activeWorld, hit) ?? {}) };
      dragY = num(dragOrig.y, 0);
      const g = rayPlaneY(origin, dir, dragY);
      grabOffset = g ? [num(dragOrig.x, 0) - g[0], 0, num(dragOrig.z, 0) - g[2]] : [0, 0, 0];
      mode = 'pendDrag';
    } else {
      gateway.dispatch({ kind: 'setSelection', id: null });
      mode = 'none';
    }
  }

  function onMove(e: PointerEvent): void {
    if (inputToGame()) return; // play·game: game owns pointer-move
    if (mode === 'none') return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
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
          const keys = ['x', 'y', 'z'] as const;
          const patch: Record<string, number> = {};
          for (const axi of [dragPlane.ax, dragPlane.ay]) {
            patch[keys[axi]!] = snap(axisStart[axi]! + (hit[axi]! - planeGrab[axi]!), 0.5, ctrl);
          }
          applyLive(patch);
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
        applyLive({
          x: snap(axisStart[0] + axisVec[0] * delta, 0.5, ctrl),
          y: snap(axisStart[1] + axisVec[1] * delta, 0.5, ctrl),
          z: snap(axisStart[2] + axisVec[2] * delta, 0.5, ctrl),
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
        applyLive({ x: num(dragOrig.x, 0), y: snap(dragY, 0.5, ctrl), z: num(dragOrig.z, 0) });
      } else {
        const g = rayPlaneY(origin, dir, dragY);
        if (g) applyLive({ x: snap(g[0] + grabOffset[0], 0.5, ctrl), y: dragY, z: snap(g[2] + grabOffset[2], 0.5, ctrl) });
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
    }
    // Stop the Inspector preview (transient op); the panel now reads the committed doc.
    gateway.dispatch({ kind: 'setFieldPreview', id: null });
    updateGizmo();
  }

  function onWheel(e: WheelEvent): void {
    if (overPanel(e.target)) return;
    if (inputToGame()) return; // play·game: game owns wheel (let it scroll/zoom in-game)
    e.preventDefault();
    dist = clampDist(dist * (e.deltaY > 0 ? 1.1 : 0.9));
    applyCamera();
  }

  function onContext(e: MouseEvent): void {
    if (!overPanel(e.target)) e.preventDefault();
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
    const t = sel !== null ? readEntTransform(gateway.activeWorld, sel) : undefined;
    if (!t) return;
    const { center, half } = entityBox(t);
    target = center;
    dist = Math.max(4, Math.max(half[0], half[1], half[2]) * 4);
    applyCamera();
  }

  // W / E / R switch gizmo mode (move / rotate / scale); F frames the selection.
  // Skipped while typing.
  function onKey(e: KeyboardEvent): void {
    const el = e.target as HTMLElement | null;
    const tag = el?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
    if (inputToGame()) return; // play·game: W/E/R/F gizmo shortcuts yield to the game
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'w') gateway.dispatch({ kind: 'setGizmoMode', mode: 'translate' });
    else if (k === 'e') gateway.dispatch({ kind: 'setGizmoMode', mode: 'rotate' });
    else if (k === 'r') gateway.dispatch({ kind: 'setGizmoMode', mode: 'scale' });
    else if (k === 'f') gateway.dispatch({ kind: 'requestFrame' });
  }

  // double-click an entity → select + frame it.
  function onDblClick(e: MouseEvent): void {
    if (overPanel(e.target)) return;
    if (inputToGame()) return; // play·game: no editor double-click select/frame
    const hit = pick(e.clientX, e.clientY);
    if (hit !== null) { gateway.dispatch({ kind: 'setSelection', id: hit }); gateway.dispatch({ kind: 'requestFrame' }); }
  }

  window.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('contextmenu', onContext);
  window.addEventListener('keydown', onKey);
  window.addEventListener('dblclick', onDblClick);
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
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('contextmenu', onContext);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('dblclick', onDblClick);
      unsubSel();
      unsubMode();
      unsubDoc();
      unregCameraOrbit();
      unregRequestFrame();
      despawnHandles();
      despawnParam();
    },
    refresh: applyCamera,
    resetCamera,
  };
}
