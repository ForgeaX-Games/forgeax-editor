// edit-mode.ts — EditMode resource injection for editor (M4 w23).
//
// Injects an EditMode resource into a World to signal editing state.
// The notEditing run condition reads this resource to freeze gameplay systems.
//
// Anchors:
//   plan-strategy D-5: EditMode resource — editor injects world.insertResource('EditMode', {active:true})
//   requirements AC-08: gameplay systems frozen in edit mode

import { World } from '@forgeax/engine-ecs';

// `World` is imported as a VALUE and used through `InstanceType<typeof World>`
// to dodge the engine `.d.ts` module-shim TS2709 ("Cannot use namespace 'World'
// as a type") that fires once this module is pulled into a consumer's tsc program
// via the editor-core barrel (w11 exports injectEditMode). Same idiom + reason as
// discoverer.ts `EcsWorld` and open-project.ts `OpenProjectWorld`; the runtime
// value is unused at type position — purely a type-resolution shim.
type EcsWorld = InstanceType<typeof World>;

export const EDIT_MODE_KEY = 'EditMode';

export interface EditModeState {
  active: boolean;
}

/**
 * Inject EditMode resource into the given world.
 * Idempotent — overwrites any existing EditMode resource.
 */
export function injectEditMode(world: EcsWorld, active: boolean): void {
  // Engine World.insertResource(key, value) — idempotent overwrite.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (world as any).insertResource('EditMode', { active } as EditModeState);
}