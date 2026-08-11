import type { DebugDraw } from '@forgeax/engine-debug-draw';
import { vec3 } from '@forgeax/engine-math';
import type { VfxGpuEmitterProgram } from '@forgeax/engine-vfx';

type Vec3 = readonly [number, number, number];
type PreviewEmitter = Pick<VfxGpuEmitterProgram, 'id' | 'bounds'>;
type BoundsDebugDraw = Pick<DebugDraw, 'aabb' | 'sphere'>;

const ACTIVE_BOUNDS_COLOR = [0.22, 0.72, 1, 0.92] as const;

export interface VfxPreviewBounds {
  readonly min: Vec3;
  readonly max: Vec3;
  readonly center: Vec3;
  readonly radius: number;
}

function emitterExtents(emitter: PreviewEmitter): { readonly min: Vec3; readonly max: Vec3 } {
  const bounds = emitter.bounds;
  if (bounds.kind === 'aabb') return { min: bounds.min, max: bounds.max };
  const radius = Math.max(0, bounds.radius);
  return {
    min: [bounds.center[0] - radius, bounds.center[1] - radius, bounds.center[2] - radius],
    max: [bounds.center[0] + radius, bounds.center[1] + radius, bounds.center[2] + radius],
  };
}

/** Derive one framing sphere from the Engine-authored per-emitter bounds. */
export function deriveVfxPreviewBounds(
  emitters: readonly PreviewEmitter[],
): VfxPreviewBounds | undefined {
  if (emitters.length === 0) return undefined;

  const min: [number, number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max: [number, number, number] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const emitter of emitters) {
    const extents = emitterExtents(emitter);
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, extents.min[axis]!);
      max[axis] = Math.max(max[axis]!, extents.max[axis]!);
    }
  }

  const center: Vec3 = [
    (min[0] + max[0]) * 0.5,
    (min[1] + max[1]) * 0.5,
    (min[2] + max[2]) * 0.5,
  ];
  let radius = 0.1;
  for (const emitter of emitters) {
    const bounds = emitter.bounds;
    if (bounds.kind === 'sphere') {
      radius = Math.max(radius, Math.hypot(
        bounds.center[0] - center[0],
        bounds.center[1] - center[1],
        bounds.center[2] - center[2],
      ) + bounds.radius);
      continue;
    }
    const farX = Math.max(Math.abs(bounds.min[0] - center[0]), Math.abs(bounds.max[0] - center[0]));
    const farY = Math.max(Math.abs(bounds.min[1] - center[1]), Math.abs(bounds.max[1] - center[1]));
    const farZ = Math.max(Math.abs(bounds.min[2] - center[2]), Math.abs(bounds.max[2] - center[2]));
    radius = Math.max(radius, Math.hypot(farX, farY, farZ));
  }
  return {
    min,
    max,
    center,
    radius,
  };
}

/** Draw one readable system AABB, or only the exact authored shape when an emitter is isolated. */
export function drawVfxPreviewBounds(
  debugDraw: BoundsDebugDraw | undefined,
  emitters: readonly PreviewEmitter[],
  enabledEmitterIds: ReadonlySet<string>,
  systemBounds: VfxPreviewBounds | undefined,
): void {
  if (debugDraw === undefined || systemBounds === undefined) return;
  const isolatedEmitter = enabledEmitterIds.size === 1
    ? emitters.find((emitter) => enabledEmitterIds.has(emitter.id))
    : undefined;
  if (isolatedEmitter === undefined) {
    debugDraw.aabb(
      vec3.create(...systemBounds.min),
      vec3.create(...systemBounds.max),
      ACTIVE_BOUNDS_COLOR,
    );
  } else if (isolatedEmitter.bounds.kind === 'aabb') {
    debugDraw.aabb(
      vec3.create(...isolatedEmitter.bounds.min),
      vec3.create(...isolatedEmitter.bounds.max),
      ACTIVE_BOUNDS_COLOR,
    );
  } else {
    debugDraw.sphere(
      vec3.create(...isolatedEmitter.bounds.center),
      isolatedEmitter.bounds.radius,
      ACTIVE_BOUNDS_COLOR,
    );
  }
}
