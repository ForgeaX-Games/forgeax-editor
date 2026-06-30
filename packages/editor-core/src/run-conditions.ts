// run-conditions.ts — composable runIf helpers for editor (M4 w23).
//
// Editor-side only: engine does not provide and() / or() combiners (A0).
// These compose existing engine runIf predicates for edit-mode gating.
//
// Anchors:
//   plan-strategy D-5: editor self-provides and() combinator
//   research Finding 6: engine has no and() — editor must supply it
//   charter P4: consistent abstraction — editor helpers don't leak engine internals

import type { World } from '@forgeax/engine-ecs';

export type RunCondition = (world: World) => boolean;

/**
 * Compose multiple run conditions with AND logic.
 */
export function and(...conds: RunCondition[]): RunCondition {
  if (conds.length === 0) return () => true;
  if (conds.length === 1) return conds[0]!;
  return (world: World) => conds.every((c) => c(world));
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
export function notEditing(world: World): boolean {
  // Use hasResource + getResource instead of try-catch for cleaner semantic matching.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = world as any;
  if (!w.hasResource?.('EditMode')) return true; // absent → true
  const state = w.getResource('EditMode') as { active?: boolean } | undefined;
  return !(state?.active);
}