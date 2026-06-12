// Viewport interaction — the "human directly manipulates the scene" half of Edit
// mode (design EDITOR-MODE P1: 视口导航 / 点选 / gizmo). The forgeax port shipped
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
  MeshFilter,
  MeshRenderer,
  Camera,
  perspective,
  TONEMAP_REINHARD_EXTENDED,
  quat,
  Materials,
  HANDLE_CUBE,
  meshFromInterleaved,
} from '@forgeax/engine-runtime';
import type { EntityId, SceneDocument } from '@forgeax/editor-core';
import { bus, getAnimPreview, getGizmoMode, getSelection, onAnimPreview, onGizmoModeChange, onSelectionChange, setFieldPreview, setGizmoMode, setSelection } from '@forgeax/editor-shared';
import type { EngineSync } from './sync';

const DEG2RAD = Math.PI / 180;

export type Vec3 = [number, number, number];

// ── pure geometry (exported for tests) ───────────────────────────────────────

/** Pixel position → normalized device coords in [-1,1], Y up. */
export function ndcFromClient(x: number, y: number, w: number, h: number): [number, number] {
  return [(x / w) * 2 - 1, 1 - (y / h) * 2];
}

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** Ray direction through an NDC point given the camera basis + vertical FOV. */
export function rayDirection(
  forward: Vec3, right: Vec3, up: Vec3,
  ndcX: number, ndcY: number, fovY: number, aspect: number,
): Vec3 {
  const t = Math.tan(fovY / 2);
  return norm([
    forward[0] + right[0] * ndcX * t * aspect + up[0] * ndcY * t,
    forward[1] + right[1] * ndcX * t * aspect + up[1] * ndcY * t,
    forward[2] + right[2] * ndcX * t * aspect + up[2] * ndcY * t,
  ]);
}

/** Ray vs axis-aligned box (center + half-extents). Returns entry distance or null. */
export function rayAABB(origin: Vec3, dir: Vec3, center: Vec3, half: Vec3): number | null {
  let tmin = -Infinity, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    const o = origin[i]!, d = dir[i]!, lo = center[i]! - half[i]!, hi = center[i]! + half[i]!;
    if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) return null; continue; }
    let t1 = (lo - o) / d, t2 = (hi - o) / d;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  return tmin >= 0 ? tmin : tmax;
}

/** Ray vs horizontal plane y = planeY. Returns the world hit point or null. */
export function rayPlaneY(origin: Vec3, dir: Vec3, planeY: number): Vec3 | null {
  if (Math.abs(dir[1]) < 1e-9) return null;
  const t = (planeY - origin[1]) / dir[1];
  if (t < 0) return null;
  return [origin[0] + dir[0] * t, planeY, origin[2] + dir[2] * t];
}

/** Parameter `t` along an axis line (axisO + t·axisU) at the point closest to the
 *  cursor ray. Used by the move gizmo to constrain a drag to one axis. */
export function closestAxisT(rayO: Vec3, rayD: Vec3, axisO: Vec3, axisU: Vec3): number {
  const w0: Vec3 = [rayO[0] - axisO[0], rayO[1] - axisO[1], rayO[2] - axisO[2]];
  const dot = (p: Vec3, q: Vec3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const a = dot(rayD, rayD), b = dot(rayD, axisU), c = dot(axisU, axisU);
  const d = dot(rayD, w0), e = dot(axisU, w0);
  const denom = a * c - b * b;
  if (Math.abs(denom) < 1e-9) return -e / (c || 1); // ray ∥ axis → project origin
  return (a * e - b * d) / denom;
}

const dot3 = (p: Vec3, q: Vec3): number => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const cross3 = (p: Vec3, q: Vec3): Vec3 => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];

/** Ray vs an arbitrary plane (point + normal). Returns the hit point or null. */
export function rayPlane(origin: Vec3, dir: Vec3, point: Vec3, normal: Vec3): Vec3 | null {
  const denom = dot3(dir, normal);
  if (Math.abs(denom) < 1e-9) return null;
  const t = dot3([point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]], normal) / denom;
  if (t < 0) return null;
  return [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
}

/** Two orthonormal vectors spanning the plane ⊥ `axis` (for measuring rotation). */
export function orthoBasis(axis: Vec3): [Vec3, Vec3] {
  const a = norm(axis);
  const ref: Vec3 = Math.abs(a[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross3(ref, a));
  return [u, cross3(a, u)];
}

/** Signed angle (radians) of the cursor ray's hit on the plane ⊥ `axis` through
 *  `center`, measured in that plane. null if the ray is parallel to the plane. */
export function angleOnAxis(rayO: Vec3, rayD: Vec3, center: Vec3, axis: Vec3): number | null {
  const hit = rayPlane(rayO, rayD, center, axis);
  if (!hit) return null;
  const [u, v] = orthoBasis(axis);
  const d: Vec3 = [hit[0] - center[0], hit[1] - center[1], hit[2] - center[2]];
  return Math.atan2(dot3(d, v), dot3(d, u));
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** A doc entity's world AABB (center + half) from its Transform. */
export function entityBox(t: { x?: number; y?: number; z?: number; scaleX?: number; scaleY?: number; scaleZ?: number }): { center: Vec3; half: Vec3 } {
  const sx = Math.abs(num(t.scaleX, 1)), sy = Math.abs(num(t.scaleY, 1)), sz = Math.abs(num(t.scaleZ, 1));
  // pad razor-thin slabs (neon strips, floor) so they stay clickable.
  const pad = 0.05;
  return {
    center: [num(t.x, 0), num(t.y, 0), num(t.z, 0)],
    half: [Math.max(sx / 2, pad), Math.max(sy / 2, pad), Math.max(sz / 2, pad)],
  };
}

// ── runtime wiring ────────────────────────────────────────────────────────────

interface WorldLike {
  set(entity: number, component: unknown, data: unknown): unknown;
  spawn(...componentDatas: unknown[]): { unwrap(): number };
  despawn(entity: number): unknown;
}
interface AssetsLike {
  register(desc: unknown): { unwrap(): unknown };
}

export interface ViewportDeps {
  canvas: HTMLCanvasElement;
  world: WorldLike;
  assets: AssetsLike;    // to register the gizmo handle materials
  camera: number;        // the editor camera entity
  sync: EngineSync;      // doc→world handle lookup (live drag) + resync
  /** Optional initial orbit framing — asset-edit mode opens close-up on the
   *  origin instead of the arena-scale default. */
  initialOrbit?: { target?: [number, number, number]; yaw?: number; pitch?: number; dist?: number };
}

export interface Viewport {
  dispose(): void;
  /** Re-aim the camera (e.g. on resize the aspect changes). */
  refresh(): void;
}

const FOV = Math.PI / 3;

export function createViewport({ canvas, world, assets, camera, sync, initialOrbit }: ViewportDeps): Viewport {
  // orbit state — frames the typical arena (centered, looking slightly down).
  let target: Vec3 = initialOrbit?.target ? [...initialOrbit.target] : [0, 2, 0];
  let yaw = initialOrbit?.yaw ?? 0.6, pitch = initialOrbit?.pitch ?? -0.5, dist = initialOrbit?.dist ?? 34;

  // current camera basis (recomputed on every applyCamera).
  let camPos: Vec3 = [0, 0, 0];
  let fwd: Vec3 = [0, 0, -1], rgt: Vec3 = [1, 0, 0], upv: Vec3 = [0, 1, 0];

  const qCam = quat.create(), qY = quat.create(), qP = quat.create();
  const tmp = new Float32Array(3);
  const tv = (out: Vec3, src: Vec3): Vec3 => {
    quat.transformVec3(tmp, qCam, src);
    out[0] = tmp[0]!; out[1] = tmp[1]!; out[2] = tmp[2]!;
    return out;
  };

  const aspect = () => (canvas.clientWidth || canvas.width) / (canvas.clientHeight || canvas.height) || 1;

  function applyCamera(): void {
    quat.fromAxisAngle(qY, [0, 1, 0], yaw);
    quat.fromAxisAngle(qP, [1, 0, 0], pitch);
    quat.multiply(qCam, qY, qP);
    tv(fwd, [0, 0, -1]); tv(rgt, [1, 0, 0]); tv(upv, [0, 1, 0]);
    camPos = [target[0] - fwd[0] * dist, target[1] - fwd[1] * dist, target[2] - fwd[2] * dist];
    world.set(camera, Transform, {
      posX: camPos[0], posY: camPos[1], posZ: camPos[2],
      quatX: qCam[0], quatY: qCam[1], quatZ: qCam[2], quatW: qCam[3],
      scaleX: 1, scaleY: 1, scaleZ: 1,
    });
    // tonemap must stay active so the HDR SkyboxBackground pass draws (this set
    // replaces the Camera component each frame, so tonemap must be re-applied).
    world.set(camera, Camera, { ...perspective({ fov: FOV, aspect: aspect(), near: 0.05, far: 2000 }), tonemap: TONEMAP_REINHARD_EXTENDED });
    updateGizmo();
    updateParamGizmo();
  }

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
  let gizmoMats: unknown[] | null = null;
  type Shape = 'translate' | 'scale' | 'rings';
  let shape: Shape | null = null;
  // bars: per-axis entity + world AABB (hit-test). planes: per-plane quad entity +
  // AABB (translate only). rings: pooled segment entities (3·RING_SEG) + the ring
  // center/radius for analytic plane hit-test.
  let barEnts: number[] = [];
  let bars: { center: Vec3; half: Vec3 }[] = [];
  let tipEnts: number[] = [];   // cone arrowheads on the translate bars
  let planeEnts: number[] = [];
  let planes: { center: Vec3; half: Vec3 }[] = [];
  let ringEnts: number[] = [];
  let ringCenter: Vec3 = [0, 0, 0];
  let ringRadius = 0;

  // A small cone mesh (apex at +Y, base ring at Y=0, closed) for the translate
  // arrowheads. Unlit material ignores normals/uv, so those are dummy. Built
  // once and reused for all three axes (oriented via per-axis quaternion).
  let coneMesh: unknown = null;
  function ensureCone(): unknown {
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
    coneMesh = assets.register(meshFromInterleaved(new Float32Array(v), new Uint16Array(idx))).unwrap();
    return coneMesh;
  }
  // Quaternion that rotates the cone's local +Y to point down each world axis.
  const TIP_QUAT: [number, number, number, number][] = [
    [0, 0, -0.70710678, 0.70710678], // X: +Y → +X
    [0, 0, 0, 1],                     // Y: identity
    [0.70710678, 0, 0, 0.70710678],   // Z: +Y → +Z
  ];

  function ensureMats(): unknown[] {
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
      return assets.register(mat).unwrap();
    });
    return gizmoMats;
  }
  function spawnHandleMesh(mesh: unknown, material: unknown): number {
    return world.spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      // engine #317: MeshRenderer.material (single) -> materials[]. Passing the
      // legacy single field leaves the gizmo unmaterialed -> default gray axes.
      { component: MeshRenderer, data: { materials: [material] } },
    ).unwrap();
  }
  const spawnHandleCube = (material: unknown): number => spawnHandleMesh(HANDLE_CUBE, material);
  function despawnHandles(): void {
    for (const e of barEnts) { try { world.despawn(e); } catch { /* gone */ } }
    for (const e of tipEnts) { try { world.despawn(e); } catch { /* gone */ } }
    for (const e of planeEnts) { try { world.despawn(e); } catch { /* gone */ } }
    for (const e of ringEnts) { try { world.despawn(e); } catch { /* gone */ } }
    barEnts = []; bars = []; tipEnts = []; planeEnts = []; planes = []; ringEnts = []; shape = null;
  }
  function buildShape(want: Shape): void {
    const mats = ensureMats();
    if (want === 'rings') {
      ringEnts = [];
      for (let i = 0; i < AXES.length; i++) for (let j = 0; j < RING_SEG; j++) ringEnts.push(spawnHandleCube(mats[i]));
    } else {
      barEnts = AXES.map((_, i) => spawnHandleCube(mats[i]));
      bars = AXES.map(() => ({ center: [0, 0, 0] as Vec3, half: [0, 0, 0] as Vec3 }));
      if (want === 'translate') {
        // Cone arrowheads at each axis tip (move gizmo only).
        const cone = ensureCone();
        tipEnts = AXES.map((_, i) => spawnHandleMesh(cone, mats[i]));
        planeEnts = PLANES.map((p) => spawnHandleCube(mats[p.mat]));
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
      world.set(barEnts[i]!, Transform, { posX: hc[0], posY: hc[1], posZ: hc[2], scaleX: sx, scaleY: sy, scaleZ: sz });
      if (hasTips) {
        // Cone base sits at the bar's outer end, apex pointing further out along
        // the axis. scaleY is the cone's local height (→ length after the +Y→axis
        // rotation); scaleX/Z are the base radius.
        const base: Vec3 = [center[0] + a.axis[0] * len, center[1] + a.axis[1] * len, center[2] + a.axis[2] * len];
        const q = TIP_QUAT[i]!;
        world.set(tipEnts[i]!, Transform, {
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
      world.set(planeEnts[i]!, Transform, { posX: hc[0], posY: hc[1], posZ: hc[2], scaleX: s[0], scaleY: s[1], scaleZ: s[2] });
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
        world.set(ringEnts[i * RING_SEG + j]!, Transform, { posX: p[0], posY: p[1], posZ: p[2], scaleX: seg, scaleY: seg, scaleZ: seg });
      }
    }
  }
  /** Re-place the gizmo on the current selection (or hide it). Sized by camera
   *  distance so handles stay grabbable at any zoom; shape switches with the mode. */
  function updateGizmo(): void {
    const sel = getSelection();
    // During a live drag the DOC isn't touched (we only world.set a preview), so
    // for the entity being dragged read its LIVE transform (dragOrig + livePatch)
    // — otherwise the gizmo lags at the pre-drag position until release.
    const live = sel !== null && dragId === sel ? { ...dragOrig, ...livePatch } : undefined;
    const t = live ?? (sel !== null ? (bus.doc.entities[sel]?.components.Transform as Record<string, number> | undefined) : undefined);
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
  let paramEnts: number[] = [];
  let paramMat: unknown | null = null;
  function ensureParamMat(): unknown {
    if (!paramMat) paramMat = assets.register(Materials.unlit([1.0, 0.82, 0.25, 1])).unwrap();
    return paramMat;
  }
  function despawnParam(): void {
    for (const e of paramEnts) { try { world.despawn(e); } catch { /* gone */ } }
    paramEnts = [];
  }
  function placeDots(points: Vec3[], size: number): void {
    if (points.length === 0) { despawnParam(); return; }
    const mat = ensureParamMat();
    while (paramEnts.length < points.length) paramEnts.push(spawnHandleCube(mat));
    while (paramEnts.length > points.length) { const e = paramEnts.pop()!; try { world.despawn(e); } catch { /* gone */ } }
    points.forEach((p, i) => world.set(paramEnts[i]!, Transform, { posX: p[0], posY: p[1], posZ: p[2], scaleX: size, scaleY: size, scaleZ: size }));
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
    const o = new Float32Array(3); quat.transformVec3(o, q, [0, 0, -1]);
    return [o[0]!, o[1]!, o[2]!];
  }
  /** Re-draw the parameter gizmo for the current selection (light/camera) or hide. */
  function updateParamGizmo(): void {
    const sel = getSelection();
    const node = sel !== null ? bus.doc.entities[sel] : undefined;
    if (!node) { despawnParam(); return; }
    const t = node.components.Transform as Record<string, number> | undefined;
    const center: Vec3 = [num(t?.x, 0), num(t?.y, 0), num(t?.z, 0)];
    const light = node.components.Light as Record<string, unknown> | undefined;
    const cam = node.components.Camera as Record<string, unknown> | undefined;
    const pts: Vec3[] = [];
    if (light) {
      const type = (light.type as string) ?? 'point';
      if (type === 'directional') {
        const dir = norm([num(light.directionX as number, -0.4), num(light.directionY as number, -1), num(light.directionZ as number, -0.3)]);
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
  // Apply a sampled clip's Transform channels to the previewed entity's world
  // transform live (no doc churn). Clearing it resyncs the world from the doc.
  function applyAnimPreview(): void {
    const ap = getAnimPreview();
    if (!ap) { sync.resync(); return; }
    const wid = sync.worldEntityFor(ap.id);
    if (wid === undefined) return;
    const t = (bus.doc.entities[ap.id]?.components.Transform as Record<string, number> | undefined) ?? {};
    const g = (k: string, d: number): number => { const v = ap.values[`Transform.${k}`]; return typeof v === 'number' ? v : num(t[k], d); };
    const data: Record<string, number> = {
      posX: g('x', 0), posY: g('y', 0), posZ: g('z', 0),
      scaleX: g('scaleX', 1), scaleY: g('scaleY', 1), scaleZ: g('scaleZ', 1),
    };
    const rx = g('rotX', 0), ry = g('rotY', 0), rz = g('rotZ', 0);
    if (rx || ry || rz) {
      quat.fromEuler(qd, rx * DEG2RAD, ry * DEG2RAD, rz * DEG2RAD, 'XYZ');
      data.quatX = qd[0]; data.quatY = qd[1]; data.quatZ = qd[2]; data.quatW = qd[3];
    } else { data.quatX = 0; data.quatY = 0; data.quatZ = 0; data.quatW = 1; }
    world.set(wid, Transform, data);
  }

  function rayAt(clientX: number, clientY: number): { origin: Vec3; dir: Vec3 } {
    const r = canvas.getBoundingClientRect();
    const [nx, ny] = ndcFromClient(clientX - r.left, clientY - r.top, r.width, r.height);
    return { origin: camPos, dir: rayDirection(fwd, rgt, upv, nx, ny, FOV, aspect()) };
  }

  /** Nearest visible doc entity hit by the ray (or null). */
  function pick(origin: Vec3, dir: Vec3): EntityId | null {
    const doc: SceneDocument = bus.doc;
    let best: EntityId | null = null, bestT = Infinity;
    for (const id of doc.order) {
      const node = doc.entities[id];
      if (!node || node.hidden) continue;
      const t = node.components.Transform as Record<string, number> | undefined;
      if (!t) continue; // organizational node — nothing to pick
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
  let dragId: EntityId | null = null;
  let dragWorld: number | undefined;
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

  /** Live-preview a Transform patch via world.set (no doc churn). Position +
   *  scale + rotation(quat from euler) are all applied; on release the patch is
   *  committed as one setComponent. */
  const applyLive = (patch: Record<string, number>): void => {
    livePatch = patch;
    if (dragWorld === undefined) return;
    const m = { ...dragOrig, ...patch };
    const data: Record<string, number> = {
      posX: num(m.x, 0), posY: num(m.y, 0), posZ: num(m.z, 0),
      scaleX: num(m.scaleX, 1), scaleY: num(m.scaleY, 1), scaleZ: num(m.scaleZ, 1),
    };
    const rx = num(m.rotX, 0), ry = num(m.rotY, 0), rz = num(m.rotZ, 0);
    if (rx || ry || rz) {
      quat.fromEuler(qd, rx * DEG2RAD, ry * DEG2RAD, rz * DEG2RAD, 'XYZ');
      data.quatX = qd[0]; data.quatY = qd[1]; data.quatZ = qd[2]; data.quatW = qd[3];
    } else { data.quatX = 0; data.quatY = 0; data.quatZ = 0; data.quatW = 1; }
    world.set(dragWorld, Transform, data);
    // Mirror the changed fields into the Inspector live (no command) — the
    // "预览" loop: numbers track the drag, the single commit lands on release.
    if (dragId !== null) for (const k in patch) setFieldPreview(dragId, `Transform.${k}`, patch[k]!);
  };
  const snap = (v: number, step: number, on: boolean): number => (on ? Math.round(v / step) * step : v);
  const ROT_KEYS = ['rotX', 'rotY', 'rotZ'];
  const SCALE_KEYS = ['scaleX', 'scaleY', 'scaleZ'];

  // A click is "in the viewport" unless it landed on one of the docked panels.
  // (The #ui overlay sits over the canvas, so e.target is usually the overlay
  // div, not the canvas — filtering panels is more robust than matching canvas.)
  const overPanel = (t: EventTarget | null): boolean =>
    !!(t as HTMLElement | null)?.closest?.('.dockleaf, .floatwin, .ed-toolbar');

  function onDown(e: PointerEvent): void {
    if (overPanel(e.target)) return; // let panels handle their own clicks
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
      dragWorld = sync.worldEntityFor(sel);
      dragOrig = { ...(bus.doc.entities[sel]!.components.Transform as Record<string, number>) };
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
    const hit = pick(origin, dir);
    if (hit !== null) {
      setSelection(hit);
      dragId = hit;
      dragWorld = sync.worldEntityFor(hit);
      dragOrig = { ...(bus.doc.entities[hit]!.components.Transform as Record<string, number>) };
      dragY = num(dragOrig.y, 0);
      const g = rayPlaneY(origin, dir, dragY);
      grabOffset = g ? [num(dragOrig.x, 0) - g[0], 0, num(dragOrig.z, 0) - g[2]] : [0, 0, 0];
      mode = 'pendDrag';
    } else {
      // Left-click on empty space deselects (Blender-style). Orbiting moved to
      // the middle button so it works even when a big object fills the viewport.
      setSelection(null);
      mode = 'none';
    }
  }

  function onMove(e: PointerEvent): void {
    if (mode === 'none') return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (mode === 'orbit') {
      yaw -= dx * 0.005;
      pitch = Math.max(-1.5, Math.min(1.5, pitch - dy * 0.005));
      applyCamera();
    } else if (mode === 'pan') {
      const k = dist * 0.0016;
      target = [target[0] - rgt[0] * dx * k + upv[0] * dy * k,
                target[1] - rgt[1] * dx * k + upv[1] * dy * k,
                target[2] - rgt[2] * dx * k + upv[2] * dy * k];
      applyCamera();
    } else if (mode === 'zoom') {
      // Ctrl+MMB drag-zoom (Blender): drag down = zoom out, up = zoom in.
      dist = Math.max(2, Math.min(300, dist * (1 + dy * 0.005)));
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
    if ((mode === 'drag' || mode === 'axisDrag') && dragId !== null && Object.keys(livePatch).length > 0) {
      // commit the final pose as ONE undoable command, merged over the original
      // Transform so untouched fields survive. resync then re-places it from the doc.
      bus.dispatch({ kind: 'setComponent', entity: dragId, component: 'Transform', patch: { ...dragOrig, ...livePatch } });
    }
    mode = 'none'; dragId = null; dragWorld = undefined; livePatch = {}; dragPlane = null;
    setFieldPreview(null); // stop the Inspector preview; it now reads the committed doc
    updateGizmo();
  }

  function onWheel(e: WheelEvent): void {
    if (overPanel(e.target)) return;
    e.preventDefault();
    dist = Math.max(2, Math.min(300, dist * (e.deltaY > 0 ? 1.1 : 0.9)));
    applyCamera();
  }

  function onContext(e: MouseEvent): void {
    if (!overPanel(e.target)) e.preventDefault();
  }

  /** Frame the current selection: center the orbit target on it + fit distance. */
  function frameSelection(): void {
    const sel = getSelection();
    const t = sel !== null ? (bus.doc.entities[sel]?.components.Transform as Record<string, number> | undefined) : undefined;
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
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'w') setGizmoMode('translate');
    else if (k === 'e') setGizmoMode('rotate');
    else if (k === 'r') setGizmoMode('scale');
    else if (k === 'f') frameSelection();
  }

  // double-click an entity → select + frame it.
  function onDblClick(e: MouseEvent): void {
    if (overPanel(e.target)) return;
    const { origin, dir } = rayAt(e.clientX, e.clientY);
    const hit = pick(origin, dir);
    if (hit !== null) { setSelection(hit); frameSelection(); }
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
  const unsubSel = onSelectionChange(refreshGizmos);
  const unsubMode = onGizmoModeChange(updateGizmo);
  const unsubDoc = bus.subscribe(() => refreshGizmos());
  const unsubAnim = onAnimPreview(applyAnimPreview);

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
      unsubAnim();
      despawnHandles();
      despawnParam();
    },
    refresh: applyCamera,
  };
}
