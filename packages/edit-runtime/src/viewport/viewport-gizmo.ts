// viewport-gizmo — the interactive selection gizmo pool (3 axis handles).
//
// Shape follows the mode (design §3): translate/scale → axis BARS; rotate →
// axis RINGS (circles in each axis plane). Rings are built from a pool of
// small cube segments (a torus mesh isn't in the handle set), reused frame-to-
// frame so orbiting/dragging only world.set transforms — never respawns.
//
// AXES / PLANES / RING_SEG / TIP_QUAT are the shared gizmo layout constants
// (viewport-gizmo-geometry.ts, M6 extraction).
//
// M4 (w20): gizmo assets + entities live in the editorWorld (editorEngine) —
// the structural half of AC-01 (gizmo can never land in the sceneWorld). The
// gizmo READS the selected entity's world Transform from `gateway.activeWorld`
// (sceneWorld) via the caller-supplied helpers (super moves VALUES across
// worlds, not identity).

import { Transform, MeshFilter, MeshRenderer, Materials } from '@forgeax/engine-runtime';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, Handle } from '@forgeax/engine-ecs';
import { meshFromInterleaved } from '@forgeax/engine-geometry';
import type { EngineFacade } from '@forgeax/editor-core';
import { quat as quatMath } from '@forgeax/engine-math';
import type { Vec3 as EngineVec3, Quat } from '@forgeax/engine-math';

import type { Vec3 } from './viewport-ray';
import { num, orthoBasis, rayAABB, rayPlane } from './viewport-ray';
import {
  AXES, PLANES, RING_SEG, TIP_QUAT, buildConeMeshData,
} from './viewport-gizmo-geometry';
import type { EditorTransform } from './viewport-entity-read';
import type { GizmoSpace } from '@forgeax/editor-core';

type Shape = 'translate' | 'scale' | 'rings';
export type GizmoMode = 'translate' | 'rotate' | 'scale';

export interface GizmoDeps {
  /** editorWorld facade — gizmo entities/assets are minted here (AC-01). */
  editorEngine: EngineFacade;
  /** Selected entity handle (null when nothing is selected). */
  getSelection(): EntityHandle | null;
  /** Current gizmo mode (translate/rotate/scale). */
  getGizmoMode(): GizmoMode;
  /** World-space Transform of the selected entity (undefined when the entity
   *  has no Transform, or is hidden, or was deleted). */
  getSelectionWorldTransform(): EditorTransform | undefined;
  /** World-space rotation quaternion of the selected entity (null when no Transform). */
  getSelectionWorldQuat(): [number, number, number, number] | null;
  /** Current gizmo coordinate space (local = follow object rotation). */
  getGizmoSpace(): GizmoSpace;
  /** Aux-entity visibility gate (w23, D-5): display='game' hides all gizmos. */
  isAuxVisible(): boolean;
  /** Current camera distance — handles are sized ∝ dist so they stay grabbable
   *  at any zoom. Read on every update (orbit / dolly change it live). */
  getDist(): number;
}

export interface GizmoPool {
  /** Re-place the gizmo on the current selection (or hide it). */
  update(): void;
  /** Which gizmo handle (if any) the ray hits — checked BEFORE entity picking.
   *  Returns 0-2 for an axis bar/ring; 3-5 (= 3 + plane index) for a plane
   *  handle. Bars/planes: ray vs AABB. Rings: ray hits the axis plane near
   *  the ring radius. */
  hit(origin: Vec3, dir: Vec3): number | null;
  /** Current rotated axis direction for handle `i` (0=X,1=Y,2=Z). In local
   *  space, these follow the object's rotation; in world space, they equal the
   *  world axes. Used by the drag system for axis-constrained movement. */
  getAxis(i: number): Vec3;
  /** Current rotated plane normal for plane handle `i` (0=XY,1=YZ,2=XZ). */
  getPlaneNormal(i: number): Vec3;
  /** Spawn a HANDLE_CUBE mesh entity — reused by the param-gizmo dot pool. */
  spawnHandleCube(material: Handle<'MaterialAsset', 'shared'>): EntityHandle;
  /** Tear down all gizmo entities (used on dispose + on aux-hide). */
  dispose(): void;
}

/** Build the interactive gizmo pool. Caller owns the update trigger (subscribe
 *  to selection / gizmo-mode / world-transform changes and call update). */
/** Rotate a Vec3 by a quaternion [x,y,z,w]. */
function rotVec3(q: [number, number, number, number], v: Vec3): Vec3 {
  const out = new Float32Array(3) as EngineVec3;
  quatMath.transformVec3(out, q, v as unknown as EngineVec3);
  return [out[0]!, out[1]!, out[2]!];
}

/** Multiply two quaternions: out = a * b. */
function mulQuat(a: [number, number, number, number], b: [number, number, number, number]): [number, number, number, number] {
  const out = quatMath.create();
  quatMath.multiply(out, a, b);
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}

/** Invert a unit quaternion. */
function invQuat(q: [number, number, number, number]): [number, number, number, number] {
  const out = quatMath.create();
  quatMath.invert(out, q);
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}

const IDENTITY_QUAT: [number, number, number, number] = [0, 0, 0, 1];

export function createGizmoPool({
  editorEngine, getSelection, getGizmoMode, getSelectionWorldTransform,
  getSelectionWorldQuat, getGizmoSpace,
  isAuxVisible, getDist,
}: GizmoDeps): GizmoPool {
  let gizmoMats: Handle<'MaterialAsset', 'shared'>[] | null = null;
  let tipMats: Handle<'MaterialAsset', 'shared'>[] | null = null;
  let shape: Shape | null = null;
  let barEnts: EntityHandle[] = [];
  let bars: { center: Vec3; half: Vec3 }[] = [];
  let tipEnts: EntityHandle[] = [];
  let planeEnts: EntityHandle[] = [];
  let planes: { center: Vec3; half: Vec3 }[] = [];
  let ringEnts: EntityHandle[] = [];
  let ringCenter: Vec3 = [0, 0, 0];
  let ringRadius = 0;

  let gizmoQuat: [number, number, number, number] = IDENTITY_QUAT;
  let gizmoCenter: Vec3 = [0, 0, 0];
  let rotatedAxes: Vec3[] = AXES.map(a => a.axis);
  let rotatedPlaneNormals: Vec3[] = PLANES.map(p => p.normal);

  // A small cone mesh (apex at +Y, base ring at Y=0, closed) for the translate
  // arrowheads. Unlit material ignores normals/uv, so those are dummy. Built
  // once and reused for all three axes (oriented via per-axis quaternion).
  let coneMesh: Handle<'MeshAsset', 'shared'> | null = null;
  function ensureCone(): Handle<'MeshAsset', 'shared'> {
    if (coneMesh) return coneMesh;
    const { vertices, indices } = buildConeMeshData();
    coneMesh = editorEngine.allocSharedRef('MeshAsset', meshFromInterleaved(vertices, indices));
    return coneMesh;
  }

  function buildOverlayMat(color: [number, number, number], queue: number): Handle<'MaterialAsset', 'shared'> {
    const base = Materials.unlit([color[0], color[1], color[2], 1], { castShadow: false }) as {
      passes?: { queue?: number; renderState?: Record<string, unknown> }[];
    };
    const mat = {
      ...base,
      passes: (base.passes ?? []).map((p) => ({
        ...p,
        queue,
        renderState: { ...(p.renderState ?? {}), depthCompare: 'always', depthWriteEnabled: false },
      })),
    };
    return editorEngine.allocSharedRef('MaterialAsset', mat);
  }

  function ensureMats(): Handle<'MaterialAsset', 'shared'>[] {
    if (!gizmoMats) gizmoMats = AXES.map((a) => buildOverlayMat(a.color, 4000));
    return gizmoMats;
  }

  function ensureTipMats(): Handle<'MaterialAsset', 'shared'>[] {
    if (!tipMats) tipMats = AXES.map((a) => buildOverlayMat(a.color, 4001));
    return tipMats;
  }

  function spawnHandleMesh(
    mesh: Handle<'MeshAsset', 'shared'>,
    material: Handle<'MaterialAsset', 'shared'>,
  ): EntityHandle {
    return editorEngine.spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      // engine #317: MeshRenderer.material (single) -> materials[]. Passing the
      // legacy single field leaves the gizmo unmaterialed → default gray axes.
      { component: MeshRenderer, data: { materials: [material] } },
    ).unwrap();
  }

  const spawnHandleCube = (material: Handle<'MaterialAsset', 'shared'>): EntityHandle =>
    spawnHandleMesh(HANDLE_CUBE, material);

  function despawnHandles(): void {
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
        const cone = ensureCone();
        const tMats = ensureTipMats();
        tipEnts = AXES.map((_, i) => spawnHandleMesh(cone, tMats[i]!));
        planeEnts = PLANES.map((p) => spawnHandleCube(tMats[p.mat]!));
        planes = PLANES.map(() => ({ center: [0, 0, 0] as Vec3, half: [0, 0, 0] as Vec3 }));
      }
    }
    shape = want;
  }

  function positionBars(center: Vec3, len: number, thick: number): void {
    const hasTips = tipEnts.length > 0;
    const tipLen = len * 0.34, tipRad = thick * 2.6;
    AXES.forEach((a, i) => {
      const ra = rotatedAxes[i]!;
      const hc: Vec3 = [center[0] + ra[0] * len / 2, center[1] + ra[1] * len / 2, center[2] + ra[2] * len / 2];
      const sx = a.axis[0] ? len : thick, sy = a.axis[1] ? len : thick, sz = a.axis[2] ? len : thick;
      editorEngine.set(barEnts[i]!, Transform, {
        pos: [hc[0], hc[1], hc[2]],
        scale: [sx, sy, sz],
        quat: gizmoQuat,
      });
      if (hasTips) {
        const base: Vec3 = [center[0] + ra[0] * len, center[1] + ra[1] * len, center[2] + ra[2] * len];
        const tipQ = mulQuat(gizmoQuat, TIP_QUAT[i]!);
        editorEngine.set(tipEnts[i]!, Transform, {
          pos: [base[0], base[1], base[2]],
          scale: [tipRad, tipLen, tipRad],
          quat: [tipQ[0], tipQ[1], tipQ[2], tipQ[3]],
        });
        const reach = len + tipLen;
        // AABB stored in gizmo-local space (unrotated) for hit testing
        bars[i]!.center = [a.axis[0] * reach / 2, a.axis[1] * reach / 2, a.axis[2] * reach / 2];
        const gx = a.axis[0] ? reach : thick, gy = a.axis[1] ? reach : thick, gz = a.axis[2] ? reach : thick;
        bars[i]!.half = [gx / 2, gy / 2, gz / 2];
      } else {
        // AABB in gizmo-local space (unrotated, relative to gizmo center)
        bars[i]!.center = [a.axis[0] * len / 2, a.axis[1] * len / 2, a.axis[2] * len / 2];
        bars[i]!.half = [sx / 2, sy / 2, sz / 2];
      }
    });
  }

  function positionPlanes(center: Vec3, len: number, thick: number): void {
    const off = len * 0.34, quad = len * 0.22;
    PLANES.forEach((p, i) => {
      const rax = rotatedAxes[p.ax]!, ray = rotatedAxes[p.ay]!;
      const hc: Vec3 = [
        center[0] + (rax[0] + ray[0]) * off, center[1] + (rax[1] + ray[1]) * off, center[2] + (rax[2] + ray[2]) * off,
      ];
      const s: Vec3 = [
        p.normal[0] ? thick : quad, p.normal[1] ? thick : quad, p.normal[2] ? thick : quad,
      ];
      editorEngine.set(planeEnts[i]!, Transform, { pos: [hc[0], hc[1], hc[2]], scale: [s[0], s[1], s[2]], quat: gizmoQuat });
      // AABB in gizmo-local space (unrotated)
      const origAx = AXES[p.ax]!.axis, origAy = AXES[p.ay]!.axis;
      planes[i]!.center = [(origAx[0] + origAy[0]) * off, (origAx[1] + origAy[1]) * off, (origAx[2] + origAy[2]) * off];
      planes[i]!.half = [s[0] / 2, s[1] / 2, s[2] / 2];
    });
  }

  function positionRings(center: Vec3, len: number, thick: number): void {
    ringCenter = center; ringRadius = len;
    const seg = thick * 1.3;
    for (let i = 0; i < AXES.length; i++) {
      const ra = rotatedAxes[i]!;
      const [u, v] = orthoBasis(ra);
      for (let j = 0; j < RING_SEG; j++) {
        const th = (j / RING_SEG) * Math.PI * 2;
        const c = Math.cos(th) * len, s = Math.sin(th) * len;
        const p: Vec3 = [center[0] + u[0] * c + v[0] * s, center[1] + u[1] * c + v[1] * s, center[2] + u[2] * c + v[2] * s];
        editorEngine.set(ringEnts[i * RING_SEG + j]!, Transform, { pos: [p[0], p[1], p[2]], scale: [seg, seg, seg] });
      }
    }
  }

  function update(): void {
    if (!isAuxVisible()) { despawnHandles(); return; }
    const sel = getSelection();
    const t = sel !== null ? getSelectionWorldTransform() : undefined;
    if (sel === null || !t) { despawnHandles(); return; }
    const center: Vec3 = [num(t.x, 0), num(t.y, 0), num(t.z, 0)];

    // Compute gizmo orientation based on coordinate space setting
    const space = getGizmoSpace();
    if (space === 'local') {
      const wq = getSelectionWorldQuat();
      gizmoQuat = wq ?? IDENTITY_QUAT;
    } else {
      gizmoQuat = IDENTITY_QUAT;
    }
    rotatedAxes = AXES.map(a => rotVec3(gizmoQuat, a.axis));
    rotatedPlaneNormals = PLANES.map(p => rotVec3(gizmoQuat, p.normal));
    gizmoCenter = center;

    const dist = getDist();
    const len = dist * 0.13, thick = dist * 0.007;
    const gm = getGizmoMode();
    const want: Shape = gm === 'rotate' ? 'rings' : gm === 'scale' ? 'scale' : 'translate';
    if (shape !== want) { despawnHandles(); buildShape(want); }
    if (want === 'rings') { positionRings(center, len, thick); return; }
    positionBars(center, len, thick);
    if (want === 'translate') positionPlanes(center, len, thick);
  }

  function hit(origin: Vec3, dir: Vec3): number | null {
    // Transform ray into gizmo-local space so axis-aligned hit testing works
    // regardless of gizmo rotation.
    const invQ = invQuat(gizmoQuat);
    const relO: Vec3 = [origin[0] - gizmoCenter[0], origin[1] - gizmoCenter[1], origin[2] - gizmoCenter[2]];
    const localOrigin: Vec3 = rotVec3(invQ, relO);
    const localO: Vec3 = [localOrigin[0] + gizmoCenter[0], localOrigin[1] + gizmoCenter[1], localOrigin[2] + gizmoCenter[2]];
    const localDir = rotVec3(invQ, dir);

    let best: number | null = null, bestT = Infinity;
    if (shape === 'rings') {
      const band = Math.max(ringRadius * 0.18, 1e-4);
      for (let i = 0; i < AXES.length; i++) {
        const hitP = rayPlane(origin, dir, ringCenter, rotatedAxes[i]!);
        if (!hitP) continue;
        const r = Math.hypot(hitP[0] - ringCenter[0], hitP[1] - ringCenter[1], hitP[2] - ringCenter[2]);
        if (Math.abs(r - ringRadius) > band) continue;
        const td = Math.hypot(hitP[0] - origin[0], hitP[1] - origin[1], hitP[2] - origin[2]);
        if (td < bestT) { bestT = td; best = i; }
      }
      return best;
    }
    // Bars and planes are stored in gizmo-local space (relative to gizmoCenter).
    // Test using the locally-transformed ray against the axis-aligned AABBs.
    for (let i = 0; i < planes.length; i++) {
      const h = planes[i]!;
      const wc: Vec3 = [gizmoCenter[0] + h.center[0], gizmoCenter[1] + h.center[1], gizmoCenter[2] + h.center[2]];
      const t = rayAABB(localO, localDir, wc, h.half);
      if (t !== null && t < bestT) { bestT = t; best = 3 + i; }
    }
    for (let i = 0; i < bars.length; i++) {
      const h = bars[i]!;
      const wc: Vec3 = [gizmoCenter[0] + h.center[0], gizmoCenter[1] + h.center[1], gizmoCenter[2] + h.center[2]];
      const t = rayAABB(localO, localDir, wc, h.half);
      if (t !== null && t < bestT) { bestT = t; best = i; }
    }
    return best;
  }

  const getAxis = (i: number): Vec3 => rotatedAxes[i] ?? AXES[i]!.axis;
  const getPlaneNormal = (i: number): Vec3 => rotatedPlaneNormals[i] ?? PLANES[i]!.normal;

  return { update, hit, getAxis, getPlaneNormal, spawnHandleCube, dispose: despawnHandles };
}
