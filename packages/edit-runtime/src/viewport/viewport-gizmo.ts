// viewport-gizmo — the interactive selection gizmo pool (3 axis handles).
//
// Shape follows the mode (design §3): translate/scale → axis handles; rotate →
// axis rings. The pool owns only the frame-local hit-test geometry and solid
// overlay vertices. Visuals are submitted by the editor's scene-after
// RenderFeature, never as editorWorld MeshFilter/MeshRenderer entities.
//
// The DebugDraw methods remain as a compatibility path for callers that still
// consume the line overlay; the editor viewport's primary Gizmo path uses the
// filled triangle stream so its appearance stays identical to the old solids.

import type { DebugDraw } from '@forgeax/engine-debug-draw';
import { quat as quatMath } from '@forgeax/engine-math';
import type { Vec3 as EngineVec3 } from '@forgeax/engine-math';

import type { Vec3 } from './viewport-ray';
import { orthoBasis, rayAABB, rayPlane } from './viewport-ray';
import {
  AXES, PLANES, RING_SEG,
} from './viewport-gizmo-geometry';
import {
  appendOverlayBox,
  appendOverlayCone,
  multiplyOverlayQuaternions,
  overlayColorFromSrgb,
  TIP_QUAT,
  type GizmoOverlayVertex,
} from './gizmo-overlay-geometry';
import type { GizmoSpace } from '@forgeax/editor-core';

type Shape = 'translate' | 'scale' | 'rings';
export type GizmoMode = 'translate' | 'rotate' | 'scale';

/** The subset of DebugDraw used by the transform and parameter gizmos. */
export type GizmoOverlayDraw = Pick<DebugDraw, 'line' | 'arrow'>;

/** Where the gizmo sits and how it is oriented, resolved by the caller from
 *  the current selection (gizmo-ue-parity plan §4.1):
 *  - single selection: the entity's world pivot (Transform pos);
 *  - multi selection (pivot='center'): the average of all selected world
 *    positions; `quat` still follows the PRIMARY (last-selected) entity so
 *    local-space orientation matches UE. */
export interface GizmoAnchor {
  center: Vec3;
  /** World rotation of the primary selection (null when it has no Transform). */
  quat: [number, number, number, number] | null;
}

export interface GizmoDeps {
  /** Current gizmo anchor (null when nothing is selected, or every selected
   *  entity lacks a Transform / is gone → the gizmo hides). */
  getAnchor(): GizmoAnchor | null;
  /** Current gizmo mode (translate/rotate/scale). */
  getGizmoMode(): GizmoMode;
  /** Current gizmo coordinate space (local = follow object rotation). */
  getGizmoSpace(): GizmoSpace;
  /** Aux-entity visibility gate (w23, D-5): display='game' hides all gizmos. */
  isAuxVisible(): boolean;
  /** View scale in world units for a given anchor point — handles are sized
   *  ∝ this so they keep a constant on-screen size (perspective: camera→anchor
   *  distance; orthographic: derived from the ortho half-height). Read on
   *  every update, so fly/orbit/zoom changes apply live. */
  getViewScale(anchor: Vec3): number;
}

export interface GizmoPool {
  /** Recompute the gizmo placement and hit-test geometry. */
  update(): void;
  /** Emit the current gizmo into the post-scene DebugDraw overlay. */
  drawOverlay(draw: GizmoOverlayDraw): void;
  /** Return the current solid geometry for the scene-after RenderFeature. */
  getOverlayVertices(): GizmoOverlayVertex[];
  /** Which gizmo handle (if any) the ray hits — checked BEFORE entity picking.
   *  Returns 0-2 for an axis bar/ring; 3-5 (= 3 + plane index) for a plane
   *  handle. Bars/planes: ray vs AABB. Rings: ray hits the axis plane near
   *  the ring radius. */
  hit(origin: Vec3, dir: Vec3): number | null;
  /** Current rotated axis direction for handle `i` (0=X,1=Y,2=Z). In local
   *  space, these follow the object's rotation; in world space, they equal
   *  the world axes. Used by the drag system for axis-constrained movement. */
  getAxis(i: number): Vec3;
  /** Current rotated plane normal for plane handle `i` (0=XY,1=YZ,2=XZ). */
  getPlaneNormal(i: number): Vec3;
  /** Tear down the frame-local gizmo state. */
  dispose(): void;
}

/** Rotate a Vec3 by a quaternion [x,y,z,w]. */
function rotVec3(q: [number, number, number, number], v: Vec3): Vec3 {
  const out = new Float32Array(3) as EngineVec3;
  quatMath.transformVec3(out, q, v as unknown as EngineVec3);
  return [out[0]!, out[1]!, out[2]!];
}

/** Invert a unit quaternion. */
function invQuat(q: [number, number, number, number]): [number, number, number, number] {
  const out = quatMath.create();
  quatMath.invert(out, q);
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}

const IDENTITY_QUAT: [number, number, number, number] = [0, 0, 0, 1];

function addScaled(a: Vec3, b: Vec3, scale: number): Vec3 {
  return [
    a[0] + b[0] * scale,
    a[1] + b[1] * scale,
    a[2] + b[2] * scale,
  ];
}

/** DebugDraw's public Vec3 is a branded engine Float32Array; gizmo math uses
 * small tuples, so convert only at the immediate-mode render boundary. */
function toEngineVec3(value: Vec3): EngineVec3 {
  return value as unknown as EngineVec3;
}

/** DebugDraw is appended after output-transform, so it consumes sRGB values. */
function debugColor(color: readonly [number, number, number]): [number, number, number, number] {
  return [color[0]!, color[1]!, color[2]!, 1];
}

/**
 * Build the interactive gizmo pool.
 *
 * `update()` is called by the viewport when selection/camera/mode changes.
 * `drawOverlay()` is called every frame by `installGizmoDebugOverlay`, because
 * DebugDraw staging is cleared after the renderer's post-scene pass.
 */
export function createGizmoPool({
  getAnchor, getGizmoMode, getGizmoSpace,
  isAuxVisible, getViewScale,
}: GizmoDeps): GizmoPool {
  let shape: Shape | null = null;
  let bars: { center: Vec3; half: Vec3 }[] = [];
  let planes: { center: Vec3; half: Vec3 }[] = [];
  let ringCenter: Vec3 = [0, 0, 0];
  let ringRadius = 0;
  let gizmoLength = 0;
  let gizmoTipLength = 0;
  let gizmoThickness = 0;

  let gizmoQuat: [number, number, number, number] = IDENTITY_QUAT;
  let gizmoCenter: Vec3 = [0, 0, 0];
  let rotatedAxes: Vec3[] = AXES.map(a => a.axis);
  let rotatedPlaneNormals: Vec3[] = PLANES.map(p => p.normal);

  function clearState(): void {
    shape = null;
    bars = [];
    planes = [];
    ringCenter = [0, 0, 0];
    ringRadius = 0;
    gizmoLength = 0;
    gizmoTipLength = 0;
    gizmoThickness = 0;
    gizmoCenter = [0, 0, 0];
  }

  function positionBars(len: number, thick: number): void {
    const hasTips = shape === 'translate';
    const tipLen = hasTips ? len * 0.34 : 0;
    const reach = len + tipLen;
    gizmoLength = len;
    gizmoTipLength = tipLen;
    gizmoThickness = thick;
    bars = AXES.map((a) => {
      // The hit AABB is stored in gizmo-local space (unrotated), while the
      // visual overlay below uses the already rotated axis vectors.
      const axisCenter = reach / 2;
      const sx = a.axis[0] ? reach : thick;
      const sy = a.axis[1] ? reach : thick;
      const sz = a.axis[2] ? reach : thick;
      return {
        center: [a.axis[0] * axisCenter, a.axis[1] * axisCenter, a.axis[2] * axisCenter],
        half: [sx / 2, sy / 2, sz / 2],
      };
    });
  }

  function positionPlanes(len: number, thick: number): void {
    const off = len * 0.34;
    const quad = len * 0.22;
    planes = PLANES.map((p) => {
      const origAx = AXES[p.ax]!.axis;
      const origAy = AXES[p.ay]!.axis;
      const s: Vec3 = [
        p.normal[0] ? thick : quad,
        p.normal[1] ? thick : quad,
        p.normal[2] ? thick : quad,
      ];
      return {
        center: [
          (origAx[0] + origAy[0]) * off,
          (origAx[1] + origAy[1]) * off,
          (origAx[2] + origAy[2]) * off,
        ],
        half: [s[0] / 2, s[1] / 2, s[2] / 2],
      };
    });
  }

  function positionRings(center: Vec3, len: number, thick: number): void {
    ringCenter = center;
    ringRadius = len;
    gizmoLength = len;
    gizmoTipLength = 0;
    gizmoThickness = thick;
    bars = [];
    planes = [];
  }

  function update(): void {
    if (!isAuxVisible()) {
      clearState();
      return;
    }
    const anchor = getAnchor();
    if (!anchor) {
      clearState();
      return;
    }
    const center = anchor.center;

    // Compute gizmo orientation based on coordinate space setting.
    const space = getGizmoSpace();
    gizmoQuat = space === 'local' ? (anchor.quat ?? IDENTITY_QUAT) : IDENTITY_QUAT;
    rotatedAxes = AXES.map(a => rotVec3(gizmoQuat, a.axis));
    rotatedPlaneNormals = PLANES.map(p => rotVec3(gizmoQuat, p.normal));
    gizmoCenter = center;

    const scale = getViewScale(center);
    const len = scale * 0.13;
    const thick = scale * 0.007;
    const gm = getGizmoMode();
    const want: Shape = gm === 'rotate' ? 'rings' : gm === 'scale' ? 'scale' : 'translate';
    shape = want;
    if (want === 'rings') {
      positionRings(center, len, thick);
      return;
    }
    positionBars(len, thick);
    if (want === 'translate') positionPlanes(len, thick);
    else planes = [];
  }

  function getOverlayVertices(): GizmoOverlayVertex[] {
    const out: GizmoOverlayVertex[] = [];
    if (shape === null || !isAuxVisible()) return out;

    if (shape === 'rings') {
      const segmentSize = gizmoThickness * 1.3;
      for (let i = 0; i < AXES.length; i++) {
        const axis = rotatedAxes[i]!;
        const [u, v] = orthoBasis(axis);
        const color = overlayColorFromSrgb(AXES[i]!.color);
        for (let j = 0; j < RING_SEG; j++) {
          const theta = (j / RING_SEG) * Math.PI * 2;
          const point: Vec3 = [
            ringCenter[0] + u[0] * Math.cos(theta) * ringRadius + v[0] * Math.sin(theta) * ringRadius,
            ringCenter[1] + u[1] * Math.cos(theta) * ringRadius + v[1] * Math.sin(theta) * ringRadius,
            ringCenter[2] + u[2] * Math.cos(theta) * ringRadius + v[2] * Math.sin(theta) * ringRadius,
          ];
          appendOverlayBox(out, point, [segmentSize, segmentSize, segmentSize], IDENTITY_QUAT, color);
        }
      }
      return out;
    }

    for (let i = 0; i < AXES.length; i++) {
      const axis = AXES[i]!;
      const rotatedAxis = rotatedAxes[i]!;
      const barCenter = addScaled(gizmoCenter, rotatedAxis, gizmoLength / 2);
      const barScale: Vec3 = [
        axis.axis[0] ? gizmoLength : gizmoThickness,
        axis.axis[1] ? gizmoLength : gizmoThickness,
        axis.axis[2] ? gizmoLength : gizmoThickness,
      ];
      appendOverlayBox(out, barCenter, barScale, gizmoQuat, overlayColorFromSrgb(axis.color));

      if (shape !== 'translate') continue;
      const base = addScaled(gizmoCenter, rotatedAxis, gizmoLength);
      const tipRotation = multiplyOverlayQuaternions(gizmoQuat, TIP_QUAT[i]!);
      appendOverlayCone(
        out,
        base,
        [gizmoThickness * 2.6, gizmoTipLength, gizmoThickness * 2.6],
        tipRotation,
        overlayColorFromSrgb(axis.color),
      );
    }

    if (shape !== 'translate') return out;

    const off = gizmoLength * 0.34;
    for (const plane of PLANES) {
      const center = addScaled(
        addScaled(gizmoCenter, rotatedAxes[plane.ax]!, off),
        rotatedAxes[plane.ay]!,
        off,
      );
      const scale: Vec3 = [
        plane.normal[0] ? gizmoThickness : gizmoLength * 0.22,
        plane.normal[1] ? gizmoThickness : gizmoLength * 0.22,
        plane.normal[2] ? gizmoThickness : gizmoLength * 0.22,
      ];
      appendOverlayBox(out, center, scale, gizmoQuat, overlayColorFromSrgb(AXES[plane.mat]!.color));
    }
    return out;
  }

  function drawOverlay(draw: GizmoOverlayDraw): void {
    if (shape === null || !isAuxVisible()) return;

    if (shape === 'rings') {
      for (let i = 0; i < AXES.length; i++) {
        const axis = rotatedAxes[i]!;
        const [u, v] = orthoBasis(axis);
        const color = debugColor(AXES[i]!.color);
        let previous: Vec3 | null = null;
        for (let j = 0; j <= RING_SEG; j++) {
          const theta = (j / RING_SEG) * Math.PI * 2;
          const point: Vec3 = [
            ringCenter[0] + u[0] * Math.cos(theta) * ringRadius + v[0] * Math.sin(theta) * ringRadius,
            ringCenter[1] + u[1] * Math.cos(theta) * ringRadius + v[1] * Math.sin(theta) * ringRadius,
            ringCenter[2] + u[2] * Math.cos(theta) * ringRadius + v[2] * Math.sin(theta) * ringRadius,
          ];
          if (previous !== null) draw.line(toEngineVec3(previous), toEngineVec3(point), color);
          previous = point;
        }
      }
      return;
    }

    const axisReach = gizmoLength + gizmoTipLength;
    for (let i = 0; i < AXES.length; i++) {
      const axis = rotatedAxes[i]!;
      const end = addScaled(gizmoCenter, axis, axisReach);
      const color = debugColor(AXES[i]!.color);
      if (shape === 'translate') {
        draw.arrow(toEngineVec3(gizmoCenter), toEngineVec3(end), color, gizmoTipLength);
      } else {
        draw.line(toEngineVec3(gizmoCenter), toEngineVec3(end), color);
      }
    }

    if (shape !== 'translate') return;

    // Plane handles remain interactive AABBs, but their visual representation
    // is now a wire square in the post-scene line overlay. This preserves the
    // XY/YZ/XZ affordance without reintroducing editorWorld MeshRenderers.
    const off = gizmoLength * 0.34;
    const halfQuad = gizmoLength * 0.22 / 2;
    for (const plane of PLANES) {
      const axis = rotatedAxes[plane.ax]!;
      const other = rotatedAxes[plane.ay]!;
      const color = debugColor(AXES[plane.mat]!.color);
      const corners: Vec3[] = [
        addScaled(addScaled(gizmoCenter, axis, off - halfQuad), other, off - halfQuad),
        addScaled(addScaled(gizmoCenter, axis, off + halfQuad), other, off - halfQuad),
        addScaled(addScaled(gizmoCenter, axis, off + halfQuad), other, off + halfQuad),
        addScaled(addScaled(gizmoCenter, axis, off - halfQuad), other, off + halfQuad),
      ];
      for (let i = 0; i < corners.length; i++) {
        draw.line(
          toEngineVec3(corners[i]!),
          toEngineVec3(corners[(i + 1) % corners.length]!),
          color,
        );
      }
    }
  }

  function hit(origin: Vec3, dir: Vec3): number | null {
    // Transform ray into gizmo-local space so axis-aligned hit testing works
    // regardless of gizmo rotation.
    const invQ = invQuat(gizmoQuat);
    const relO: Vec3 = [origin[0] - gizmoCenter[0], origin[1] - gizmoCenter[1], origin[2] - gizmoCenter[2]];
    const localOrigin: Vec3 = rotVec3(invQ, relO);
    const localO: Vec3 = [localOrigin[0] + gizmoCenter[0], localOrigin[1] + gizmoCenter[1], localOrigin[2] + gizmoCenter[2]];
    const localDir = rotVec3(invQ, dir);

    let best: number | null = null;
    let bestT = Infinity;
    if (shape === 'rings') {
      const band = Math.max(ringRadius * 0.18, 1e-4);
      for (let i = 0; i < AXES.length; i++) {
        const hitP = rayPlane(origin, dir, ringCenter, rotatedAxes[i]!);
        if (!hitP) continue;
        const radius = Math.hypot(
          hitP[0] - ringCenter[0],
          hitP[1] - ringCenter[1],
          hitP[2] - ringCenter[2],
        );
        if (Math.abs(radius - ringRadius) > band) continue;
        const td = Math.hypot(
          hitP[0] - origin[0],
          hitP[1] - origin[1],
          hitP[2] - origin[2],
        );
        if (td < bestT) {
          bestT = td;
          best = i;
        }
      }
      return best;
    }

    // Bars and planes are stored in gizmo-local space (relative to
    // gizmoCenter). Test using the locally-transformed ray against the
    // axis-aligned AABBs.
    for (let i = 0; i < planes.length; i++) {
      const handle = planes[i]!;
      const worldCenter: Vec3 = [
        gizmoCenter[0] + handle.center[0],
        gizmoCenter[1] + handle.center[1],
        gizmoCenter[2] + handle.center[2],
      ];
      const t = rayAABB(localO, localDir, worldCenter, handle.half);
      if (t !== null && t < bestT) {
        bestT = t;
        best = 3 + i;
      }
    }
    for (let i = 0; i < bars.length; i++) {
      const handle = bars[i]!;
      const worldCenter: Vec3 = [
        gizmoCenter[0] + handle.center[0],
        gizmoCenter[1] + handle.center[1],
        gizmoCenter[2] + handle.center[2],
      ];
      const t = rayAABB(localO, localDir, worldCenter, handle.half);
      if (t !== null && t < bestT) {
        bestT = t;
        best = i;
      }
    }
    return best;
  }

  const getAxis = (i: number): Vec3 => rotatedAxes[i] ?? AXES[i]!.axis;
  const getPlaneNormal = (i: number): Vec3 => rotatedPlaneNormals[i] ?? PLANES[i]!.normal;

  return {
    update,
    drawOverlay,
    getOverlayVertices,
    hit,
    getAxis,
    getPlaneNormal,
    dispose: clearState,
  };
}
