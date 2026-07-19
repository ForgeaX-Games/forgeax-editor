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

// Local alias for the engine `World` class type (imported type-only).
type EcsWorld = World;

export type RunCondition = (world: EcsWorld) => boolean;

/**
 * Compose multiple run conditions with AND logic.
 */
export function and(...conds: RunCondition[]): RunCondition {
  if (conds.length === 0) return () => true;
  if (conds.length === 1) return conds[0]!;
  return (world: EcsWorld) => conds.every((c) => c(world));
}

// D-7 (M6): `notEditing` was removed. After editorWorld was forked from
// sceneWorld (M4), the editWorld is never frozen and game systems are
// structurally absent from the edit-mode active schedule — so a "not editing"
// run-condition gate has no consumer. `and` stays because it is a general
// runIf combinator the engine does not provide (research Finding 6).