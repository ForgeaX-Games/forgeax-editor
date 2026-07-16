// viewport-transform — the transform-space boundary for editor viewport gestures.
//
// The engine's propagation contract is `child.world = parent.world × child.local`.
// Viewport pointer geometry produces absolute world-space targets, while authored
// Transform.pos is always stored in parent-local coordinates. Keep the inverse in
// one pure helper so every drag path shares the same scale/rotation-safe conversion.

import { mat4, vec3, type Mat4Like, type Vec3 as EngineVec3 } from '@forgeax/engine-math';

export type ViewportVec3 = [number, number, number];

/** Convert a world-space point into the local coordinate system of its parent. */
export function worldPointToParentLocal(parentWorld: Mat4Like, target: ViewportVec3): ViewportVec3 {
  const inverse = mat4.invert(mat4.create(), parentWorld);
  const local = vec3.create();
  mat4.transformPoint(local, inverse, target as unknown as EngineVec3);
  return [local[0]!, local[1]!, local[2]!];
}
