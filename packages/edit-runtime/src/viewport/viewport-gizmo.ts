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

import type { Vec3 } from './viewport-ray';
import { num, orthoBasis, rayAABB, rayPlane } from './viewport-ray';
import {
  AXES, PLANES, RING_SEG, TIP_QUAT, buildConeMeshData,
} from './viewport-gizmo-geometry';
import type { EditorTransform } from './viewport-entity-read';

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
  /** Spawn a HANDLE_CUBE mesh entity — reused by the param-gizmo dot pool. */
  spawnHandleCube(material: Handle<'MaterialAsset', 'shared'>): EntityHandle;
  /** Tear down all gizmo entities (used on dispose + on aux-hide). */
  dispose(): void;
}

/** Build the interactive gizmo pool. Caller owns the update trigger (subscribe
 *  to selection / gizmo-mode / world-transform changes and call update). */
export function createGizmoPool({
  editorEngine, getSelection, getGizmoMode, getSelectionWorldTransform,
  isAuxVisible, getDist,
}: GizmoDeps): GizmoPool {
  // Gizmo entities are minted by engine.spawn().unwrap() → genuine branded
  // EntityHandle values; type them as such so engine.set/despawn (strict after
  // the facade tightening) accept them without a per-call brand cast.
  let gizmoMats: Handle<'MaterialAsset', 'shared'>[] | null = null;
  let shape: Shape | null = null;
  let barEnts: EntityHandle[] = [];
  let bars: { center: Vec3; half: Vec3 }[] = [];
  let tipEnts: EntityHandle[] = []; // cone arrowheads on the translate bars
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
    const { vertices, indices } = buildConeMeshData();
    coneMesh = editorEngine.allocSharedRef('MeshAsset', meshFromInterleaved(vertices, indices));
    return coneMesh;
  }

  function ensureMats(): Handle<'MaterialAsset', 'shared'>[] {
    if (!gizmoMats) gizmoMats = AXES.map((a) => {
      // Always-on-top gizmo: draw in the Overlay queue (4000, drawn last) with
      // depthCompare:'always' + no depth write, so handles are never hidden
      // behind the (possibly huge) object they're anchored on.
      const base = Materials.unlit([a.color[0], a.color[1], a.color[2], 1], { castShadow: false }) as {
        passes?: { queue?: number; renderState?: Record<string, unknown> }[];
      };
      const mat = {
        ...base,
        passes: (base.passes ?? []).map((p) => ({
          ...p,
          queue: 4000, // RenderQueue.Overlay
          renderState: { ...(p.renderState ?? {}), depthCompare: 'always', depthWriteEnabled: false },
        })),
      };
      return editorEngine.allocSharedRef('MaterialAsset', mat);
    });
    return gizmoMats;
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

  function update(): void {
    if (!isAuxVisible()) { despawnHandles(); return; }
    const sel = getSelection();
    // Read the world-space transform — the caller's applyLive has already
    // recomputed the world matrix, so there is no lag.
    const t = sel !== null ? getSelectionWorldTransform() : undefined;
    if (sel === null || !t) { despawnHandles(); return; }
    const center: Vec3 = [num(t.x, 0), num(t.y, 0), num(t.z, 0)];
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
    let best: number | null = null, bestT = Infinity;
    if (shape === 'rings') {
      const band = Math.max(ringRadius * 0.18, 1e-4);
      for (let i = 0; i < AXES.length; i++) {
        const hitP = rayPlane(origin, dir, ringCenter, AXES[i]!.axis);
        if (!hitP) continue;
        const r = Math.hypot(hitP[0] - ringCenter[0], hitP[1] - ringCenter[1], hitP[2] - ringCenter[2]);
        if (Math.abs(r - ringRadius) > band) continue;
        const td = Math.hypot(hitP[0] - origin[0], hitP[1] - origin[1], hitP[2] - origin[2]);
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

  return { update, hit, spawnHandleCube, dispose: despawnHandles };
}
