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
 *
 * @param conds 0-2+ run conditions to AND together.
 *   - 0 conds → always true.
 *   - 1 cond → identity (returns the single condition).
 *   - 2+ conds → AND of all.
 */
export function and(...conds: RunCondition[]): RunCondition {
  if (conds.length === 0) return () => true;
  if (conds.length === 1) return conds[0]!;
  return (world: World) => conds.every((c) => c(world));
}

/**
 * notEditing — returns true when the editor is NOT in edit mode.
 *
 * Edit mode is signalled by an EditMode resource with `active: true`.
 * When the resource is absent or `active === false`, notEditing returns `false`
 * (systems are allowed to run).
 */
export function notEditing(world: World): boolean {
  return !(world as any).getResource?.('EditMode')?.active;
}
