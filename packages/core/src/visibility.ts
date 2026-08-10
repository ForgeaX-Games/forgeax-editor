// visibility — the editor read face for the engine-owned visibility contract.
//
// Visibility intent belongs to @forgeax/engine-render. The editor may expose
// product operations and projections around that intent, but it must not create
// a second marker or materialize effective state onto descendants. Render and
// editor consumers both derive effective state through resolveVisibility().

import type { EntityHandle, World } from '@forgeax/engine-ecs';
import {
  resolveVisibility,
  Visibility,
  VisibilityStateValue,
  visibilityStateFromU32,
} from '@forgeax/engine-render';
import type {
  VisibilityResolution,
  VisibilitySnapshot,
  VisibilityState,
} from '@forgeax/engine-render';

export {
  resolveVisibility,
  Visibility,
  VisibilityStateValue,
  visibilityStateFromU32,
};
export type { VisibilityResolution, VisibilitySnapshot, VisibilityState };

/** Read authored intent. An absent component is the engine's inherited state. */
export function readVisibilityIntent(world: World, entity: EntityHandle): VisibilityState {
  const result = world.get(entity, Visibility);
  if (!result.ok) return 'inherited';
  return visibilityStateFromU32(Number((result.value as { state: number }).state)) ?? 'inherited';
}

/**
 * Read one entity's authored and effective visibility from one prepared
 * snapshot. Entities without a Visibility component still receive an
 * inherited/default resolution for editor projections.
 */
export function readEntityVisibility(
  world: World,
  entity: EntityHandle,
  snapshot: VisibilitySnapshot = resolveVisibility(world),
): VisibilityResolution {
  const resolved = snapshot.get(entity);
  if (resolved !== undefined) return resolved;
  const effective = snapshot.effective(entity);
  return {
    intent: readVisibilityIntent(world, entity),
    effective,
    source: effective === 'hidden' ? 'parent' : 'default',
  };
}
