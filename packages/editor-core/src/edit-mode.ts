// edit-mode.ts — EditMode resource injection for editor (M4 w23).
//
// Injects an EditMode resource into a World to signal editing state.
// The notEditing run condition reads this resource to freeze gameplay systems.
//
// Anchors:
//   plan-strategy D-5: EditMode resource — editor injects world.insertResource('EditMode', {active:true})
//   requirements AC-08: gameplay systems frozen in edit mode

import type { World } from '@forgeax/engine-ecs';

export const EDIT_MODE_KEY = 'EditMode';

export interface EditModeState {
  active: boolean;
}

/**
 * Inject EditMode resource into the given world.
 * Idempotent — overwrites any existing EditMode resource.
 */
export function injectEditMode(world: World, active: boolean): void {
  // Engine World.insertResource(key, value) — idempotent overwrite.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (world as any).insertResource('EditMode', { active } as EditModeState);
}