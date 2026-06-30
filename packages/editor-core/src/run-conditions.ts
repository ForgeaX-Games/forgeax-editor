// run-conditions.ts — composable runIf helpers for editor (M4 w23).
//
// Editor-side only: engine does not provide and() / or() combiners (A0).
// These compose existing engine runIf predicates for edit-mode gating.
//
// Anchors:
//   plan-strategy D-5: editor self-provides and() combinator
//   research Finding 6: engine has no and() — editor must supply it
//   charter P4: consistent abstraction — editor helpers don't leak engine internals

import { World } from '@forgeax/engine-ecs';

// `World` is imported as a VALUE and used through `InstanceType<typeof World>`
// to dodge the engine `.d.ts` module-shim TS2709 ("Cannot use namespace 'World'
// as a type") that fires once this module is pulled into a consumer's tsc program
// via the editor-core barrel (discoverer → run-conditions, w10). Same idiom +
// reason as discoverer.ts `EcsWorld` and open-project.ts `OpenProjectWorld`; the
// runtime value is unused at type position — purely a type-resolution shim.
type EcsWorld = InstanceType<typeof World>;

export type RunCondition = (world: EcsWorld) => boolean;

/**
 * Compose multiple run conditions with AND logic.
 */
export function and(...conds: RunCondition[]): RunCondition {
  if (conds.length === 0) return () => true;
  if (conds.length === 1) return conds[0]!;
  return (world: EcsWorld) => conds.every((c) => c(world));
}

/**
 * notEditing — true when we are NOT in edit mode.
 *
 * Formula: !getResource('EditMode')?.active (plan-strategy D-5).
 *
 * - EditMode.active=true  → notEditing=false (systems frozen in edit mode)
 * - EditMode.active=false → notEditing=true  (systems run in play mode)
 * - EditMode absent       → notEditing=true  (default: systems run)
 */
export function notEditing(world: EcsWorld): boolean {
  // Use hasResource + getResource instead of try-catch for cleaner semantic matching.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = world as any;
  if (!w.hasResource?.('EditMode')) return true; // absent → true
  const state = w.getResource('EditMode') as { active?: boolean } | undefined;
  return !(state?.active);
}