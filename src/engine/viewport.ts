// Viewport interaction — the "human directly manipulates the scene" half of Edit
// mode (design EDITOR-MODE P1: 视口导航 / 点选 / gizmo). The forgeax port shipped
// only the data model + Hierarchy + Inspector + doc→world render, leaving the
// canvas inert; this module adds:
//   • orbit camera   — left-drag empty = orbit, right/middle-drag = pan, wheel = zoom
//   • click-to-pick  — left-click an entity → select it (ray vs per-entity AABB)
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
  quat,
  Materials,
  HANDLE_CUBE,
} from '@forgeax/engine-runtime';
import type { EntityId, SceneDocument } from '../core/types';
import { bus, getGizmoMode, getSelection, onGizmoModeChange, onSelectionChange, setGizmoMode, setSelection } from '../store';
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
}

export interface Viewport {
  dispose(): void;
  /** Re-aim the camera (e.g. on resize the aspect changes). */
  refresh(): void;
}

const FOV = Math.PI / 3;

export function createViewport({ canvas, world, assets, camera, sync }: ViewportDeps): Viewport {
  // orbit state — frames the typical arena (centered, looking slightly down).
  let target: Vec3 = [0, 2, 0];
  let yaw = 0.6, pitch = -0.5, dist = 34;

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
    world.set(camera, Camera, perspective({ fov: FOV, aspect: aspect(), near: 0.05, far: 2000 }));
    updateGizmo();
  }

  // ── translate gizmo (3 axis handles on the selection) ──────────────────────
  const AXES: { axis: Vec3; color: [number, number, number] }[] = [
    { axis: [1, 0, 0], color: [1.0, 0.25, 0.2] },  // X red
    { axis: [0, 1, 0], color: [0.3, 1.0, 0.35] },  // Y green
    { axis: [0, 0, 1], color: [0.3, 0.55, 1.0] },  // Z blue
  ];
  let gizmoMats: unknown[] | null = null;
  // per-axis handle: world entity + its world AABB (for hit-testing).
  let handles: { ent: number; center: Vec3; half: Vec3 }[] = [];

  function ensureMats(): unknown[] {
    if (!gizmoMats) gizmoMats = AXES.map((a) => assets.register(Materials.unlit([a.color[0], a.color[1], a.color[2], 1])).unwrap());
    return gizmoMats;
  }
  function despawnHandles(): void {
    for (const h of handles) { try { world.despawn(h.ent); } catch { /* gone */ } }
    handles = [];
  }
  /** Re-place the gizmo on the current selection (or hide it). Handles are sized
   *  by camera distance so they stay grabbable at any zoom. */
  function updateGizmo(): void {
    const sel = getSelection();
    const t = sel !== null ? (bus.doc.entities[sel]?.components.Transform as Record<string, number> | undefined) : undefined;
    if (sel === null || !t) { despawnHandles(); return; }
    const center: Vec3 = [num(t.x, 0), num(t.y, 0), num(t.z, 0)];
    const len = dist * 0.13, thick = dist * 0.014;
    if (handles.length !== AXES.length) {
      despawnHandles();
      const mats = ensureMats();
      handles = AXES.map((_, i) => ({ ent: world.spawn(
        { component: Transform, data: { posX: center[0], posY: center[1], posZ: center[2] } },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { material: mats[i] } },
      ).unwrap(), center: [0, 0, 0] as Vec3, half: [0, 0, 0] as Vec3 }));
    }
    AXES.forEach((a, i) => {
      const hc: Vec3 = [center[0] + a.axis[0] * len / 2, center[1] + a.axis[1] * len / 2, center[2] + a.axis[2] * len / 2];
      const sx = a.axis[0] ? len : thick, sy = a.axis[1] ? len : thick, sz = a.axis[2] ? len : thick;
      world.set(handles[i]!.ent, Transform, { posX: hc[0], posY: hc[1], posZ: hc[2], scaleX: sx, scaleY: sy, scaleZ: sz });
      handles[i]!.center = hc;
      handles[i]!.half = [sx / 2, sy / 2, sz / 2];
    });
  }
  /** Which gizmo axis (if any) the ray hits — checked before entity picking. */
  function hitGizmo(origin: Vec3, dir: Vec3): number | null {
    let best: number | null = null, bestT = Infinity;
    for (let i = 0; i < handles.length; i++) {
      const h = handles[i]!;
      const t = rayAABB(origin, dir, h.center, h.half);
      if (t !== null && t < bestT) { bestT = t; best = i; }
    }
    return best;
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
  type Mode = 'none' | 'orbit' | 'pan' | 'pendDrag' | 'drag' | 'axisDrag';
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
  };
  const snap = (v: number, step: number, on: boolean): number => (on ? Math.round(v / step) * step : v);
  const ROT_KEYS = ['rotX', 'rotY', 'rotZ'];
  const SCALE_KEYS = ['scaleX', 'scaleY', 'scaleZ'];

  // A click is "in the viewport" unless it landed on one of the docked panels.
  // (The #ui overlay sits over the canvas, so e.target is usually the overlay
  // div, not the canvas — filtering panels is more robust than matching canvas.)
  const overPanel = (t: EventTarget | null): boolean =>
    !!(t as HTMLElement | null)?.closest?.('.ed-left, .ed-right, .ed-toolbar');

  function onDown(e: PointerEvent): void {
    if (overPanel(e.target)) return; // let panels handle their own clicks
    lastX = downX = e.clientX; lastY = downY = e.clientY;
    if (e.button === 1 || e.button === 2) { mode = 'pan'; e.preventDefault(); return; }
    if (e.button !== 0) return;
    const { origin, dir } = rayAt(e.clientX, e.clientY);
    // gizmo handles take priority over entity/orbit picking.
    const sel = getSelection();
    const ax = sel !== null ? hitGizmo(origin, dir) : null;
    if (ax !== null && sel !== null) {
      dragId = sel;
      dragWorld = sync.worldEntityFor(sel);
      dragOrig = { ...(bus.doc.entities[sel]!.components.Transform as Record<string, number>) };
      axisIdx = ax;
      axisVec = AXES[ax]!.axis;
      axisStart = [num(dragOrig.x, 0), num(dragOrig.y, 0), num(dragOrig.z, 0)];
      if (getGizmoMode() === 'rotate') angle0 = angleOnAxis(origin, dir, axisStart, axisVec) ?? 0;
      else axisT0 = closestAxisT(origin, dir, axisStart, axisVec);
      livePatch = {};
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
      mode = 'orbit';
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
    } else if (mode === 'axisDrag') {
      const { origin, dir } = rayAt(e.clientX, e.clientY);
      const ctrl = e.ctrlKey || e.metaKey;
      const gm = getGizmoMode();
      if (gm === 'rotate') {
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
    mode = 'none'; dragId = null; dragWorld = undefined; livePatch = {};
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

  // W / E / R switch gizmo mode (move / rotate / scale) — skipped while typing.
  function onKey(e: KeyboardEvent): void {
    const el = e.target as HTMLElement | null;
    const tag = el?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'w') setGizmoMode('translate');
    else if (k === 'e') setGizmoMode('rotate');
    else if (k === 'r') setGizmoMode('scale');
  }

  window.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('contextmenu', onContext);
  window.addEventListener('keydown', onKey);
  // the gizmo follows the selection (Hierarchy click, viewport pick, AI, …) and
  // re-tints when the mode changes.
  const unsubSel = onSelectionChange(updateGizmo);
  const unsubMode = onGizmoModeChange(updateGizmo);

  applyCamera(); // also paints the gizmo if something is already selected

  return {
    dispose() {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('contextmenu', onContext);
      window.removeEventListener('keydown', onKey);
      unsubSel();
      unsubMode();
      despawnHandles();
    },
    refresh: applyCamera,
  };
}
