// viewport-entity-read — module-level adapters that translate engine Transform
// PODs (array-TRS: pos[3] / quat[4] / scale[3] arrays, feat-20260709) into the
// editor's euler-degree shape (x/y/z + rotX/rotY/rotZ + scale*). The gizmo /
// drag / pick math is written against the editor shape, so every read goes
// through here (quat→euler conversion is centralised via euler-quat SSOT —
// AGENTS.md #6).
//
// M7-a (AC-15): doc.entities mirror is deleted; the engine World is the SSOT.
// entComponent(session, id, 'Transform') returns the engine POD, and callers
// keep their "nothing to gizmo/pick" fast-exit on undefined (organizational
// nodes have no Transform).
//
// LOCAL vs WORLD variant: same entity, different meanings.
//   - LOCAL  → parent-relative POD as stored on the entity; the drag system
//              writes back into `pos`, so it needs the local shape.
//   - WORLD  → absolute translation read from the computed 4×4 world column
//              matrix ([12..14]); rotation + scale stay local (matrix→world-
//              rot decomposition is non-trivial and the callers that read rot/
//              scale — param-gizmo, entityBox — operate on root entities where
//              local == world). The gizmo/pick math needs world positions or
//              nested entities lag by tens of units and end up mispositioned.

import type { World, EntityHandle } from '@forgeax/engine-ecs';
import type { Quat } from '@forgeax/engine-math';
import { mat4, vec3, quat as quatMath } from '@forgeax/engine-math';
import { entComponent, entComponents, quatToEuler } from '@forgeax/editor-core';
import { worldPointToParentLocal } from './viewport-transform';
import type { Vec3 } from './viewport-ray';

// Declared as a type alias (not interface) so TS treats its shape as closed:
// all-number fields are structurally compatible with `Record<string, number>`,
// which is what viewport-gizmo-geometry (lightGizmoPoints / cameraGizmoPoints)
// consumes. Interfaces are considered open (declaration-merging-friendly), so
// that assignability wouldn't hold and the callers would need a cast.
export type EditorTransform = {
  x: number; y: number; z: number;
  rotX: number; rotY: number; rotZ: number;
  scaleX: number; scaleY: number; scaleZ: number;
};

/** Index a stored engine array<f32,N> column value (number[] | Float32Array),
 *  falling back to `d` for a missing / non-finite axis. */
export function ax(arr: unknown, i: number, d: number): number {
  const v = (arr as ArrayLike<number> | undefined)?.[i];
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

/** Read the entity's LOCAL Transform (pos/quat/scale as stored in the engine).
 *  The drag system writes BACK to engine `pos`, so it needs the local shape. */
export function readLocalTransform(world: World, handle: EntityHandle): EditorTransform | undefined {
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
 *  matrix column-major [12..14]; rotation + scale stay local for now — see the
 *  header for why). Falls back to the local read if the world matrix is missing. */
export function readWorldTransform(world: World, handle: EntityHandle): EditorTransform | undefined {
  const r = entComponent(world, handle, 'Transform');
  if (!r.ok) return undefined;
  const t = r.value as Record<string, unknown>;
  const w = t.world as ArrayLike<number> | undefined;
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
export function worldPositionToLocal(world: World, handle: EntityHandle, target: Vec3): Vec3 {
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

/** Read the entity's world-space rotation quaternion from the world matrix.
 *  Decomposes the world matrix to extract translation, rotation, and scale. */
export function readWorldQuat(world: World, handle: EntityHandle): [number, number, number, number] | null {
  const r = entComponent(world, handle, 'Transform');
  if (!r.ok) return null;
  const t = r.value as Record<string, unknown>;
  const w = t.world as ArrayLike<number> | undefined;
  if (!w || w.length < 16) {
    const q = t.quat as ArrayLike<number> | undefined;
    if (!q || q.length < 4) return null;
    return [ax(q, 0, 0), ax(q, 1, 0), ax(q, 2, 0), ax(q, 3, 1)];
  }
  const pos = vec3.create();
  const rot = quatMath.create();
  const scl = vec3.create();
  mat4.decompose(pos, rot, scl, w as unknown as Parameters<typeof mat4.decompose>[3]);
  return [rot[0]!, rot[1]!, rot[2]!, rot[3]!];
}

/** EditorHidden is an editor-only marker; the entComponents walk surfaces it
 *  from the active world. */
export function isEntHidden(world: World, handle: EntityHandle): boolean {
  return 'EditorHidden' in entComponents(world, handle);
}
