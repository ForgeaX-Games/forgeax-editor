// store/handle-pair — the super handle-pair type + three-layer validation.
//
// feat-20260709-editor-world-partition-editorworld-super-composite / M5 (w25).
//
// A HandlePair binds an engine EntityHandle to the WORLD it belongs to (worldRef)
// AND the epoch of that world's binding when the pair was minted. This is the one
// defence against the RD3 red line: the engine's per-entity generation guard does
// NOT stop cross-world misuse — an editorWorld handle whose (index, generation)
// also happens to be live in the sceneWorld makes `World.get` silently return the
// WRONG entity. Only an explicit worldRef closes that gap.
//
// validateHandlePair runs three layers, in order, short-circuiting on the first
// failure so a caller learns the single most-specific cause (charter P3):
//
//   Layer 1 — worldRef: pair.worldRef !== binding.worldRef → 'world-mismatch'.
//             A CALLER BUG (wrong world routing). Self-rescue: fix the routing.
//             Distinct .code (not a stale reason) because the self-rescue action
//             differs from a lifecycle event (D-8).
//   Layer 2 — epoch: pair.epoch !== binding.epoch → 'stale-entity-handle' with
//             detail.reason 'world-epoch-mismatch'. A whole-world reload bumped
//             the binding epoch; every pair minted at the prior epoch dies in one
//             comparison (batch invalidation, AC-05). Self-rescue: re-query /
//             rebuild selection.
//   Layer 3 — generation: delegate to engine World.get(entity, Name). A stale /
//             recycled handle in the SAME world → 'stale-entity-handle' with
//             detail.reason 'stale-entity' (the engine's own guard, passed
//             through). Name is intrinsic (every live entity has it), so its
//             failure is a reliable liveness probe (same rationale as
//             entity-state.ts isStale).
//
// This module is world-agnostic and lives in core (DAG: core cannot up-import
// edit-runtime's WorldBinding, RD4). It defines its OWN binding contract
// (HandlePairBinding) — the (worldRef, epoch, world) triple it reads — which
// edit-runtime's WorldManager satisfies structurally. entity-state.ts (w27)
// consumes validateHandlePair; selection.ts (w26) mints HandlePairs.
//
// Anchors:
//   plan-strategy §2 D-4 (three-layer validation = worldRef + epoch + engine gen)
//   plan-strategy §2 D-8 (real codes: stale-entity-handle family + .detail.reason;
//     new code world-mismatch; Δ-concept net +1)
//   research RD3 (engine generation does NOT defend cross-world misuse)
//   requirements AC-05 (scene reload handle batch invalidation — RED LINE) / AC-06

import { Name } from '@forgeax/engine-runtime';
import type { World } from '@forgeax/engine-ecs';
import type { EntityHandle } from '../scene/scene-types';

/** A world-bound entity handle: the entity plus the worldRef + epoch it was
 *  minted against. worldRef mirrors WorldBinding's stable indices (0 = editor,
 *  1 = scene). super holds these instead of bare EntityHandles. */
export interface HandlePair {
  /** Stable world reference (0 = editorWorld, 1 = sceneWorld). */
  readonly worldRef: number;
  /** The binding epoch at mint time; a reload bumps it → batch invalidation. */
  readonly epoch: number;
  /** The engine entity handle. */
  readonly entity: EntityHandle;
}

/** The (worldRef, epoch, world) triple validateHandlePair reads. edit-runtime's
 *  WorldManager binding satisfies this structurally; core defines it here to stay
 *  DAG-legal (core must not import edit-runtime). */
export interface HandlePairBinding {
  readonly worldRef: number;
  readonly epoch: number;
  readonly world: World;
}

/** Why a handle-pair failed the epoch or generation layer (D-8). Narrows the
 *  'stale-entity-handle' error so an AI/human can pick the right self-rescue. */
export type HandlePairStaleReason = 'world-epoch-mismatch' | 'stale-entity';

/** Cross-world misuse (layer 1). A caller bug — carries the expected vs actual
 *  worldRef so the fix (correct the world routing) is one read away. */
export interface WorldMismatchError {
  readonly code: 'world-mismatch';
  readonly hint: string;
  readonly entity: EntityHandle;
  readonly detail: {
    readonly expectedWorldRef: number;
    readonly actualWorldRef: number;
  };
}

/** Handle invalidation (layers 2 & 3). Reuses the editor's existing
 *  'stale-entity-handle' code family, narrowed by detail.reason (D-8). */
export interface HandlePairStaleError {
  readonly code: 'stale-entity-handle';
  readonly hint: string;
  readonly entity: EntityHandle;
  readonly detail: {
    readonly reason: HandlePairStaleReason;
    /** For the engine-passthrough case, the engine's own error code
     *  ('stale-entity') — so the engine guard remains visible at this layer. */
    readonly engineCode?: string;
  };
}

/** validateHandlePair result: ok with the resolved entity, or a structured
 *  error. Shape mirrors gateway.dispatch / entity-state results (charter P4). */
export type HandlePairResult =
  | { ok: true; entity: EntityHandle }
  | { ok: false; error: WorldMismatchError | HandlePairStaleError };

const EPOCH_HINT =
  'this world was reloaded; the handle is from a previous epoch — re-query the world or rebuild the selection for a fresh handle';
const STALE_HINT =
  'entity was despawned in this world — re-query the world or call getSelection() for a fresh handle';

/**
 * Run the three-layer handle-pair validation against a binding.
 *
 * @param pair    the super-held (worldRef, epoch, entity) handle pair.
 * @param binding the live (worldRef, epoch, world) target to validate against.
 * @returns ok with the entity, or the first (most-specific) layer's error.
 */
export function validateHandlePair(
  pair: HandlePair,
  binding: HandlePairBinding,
): HandlePairResult {
  // ── Layer 1: worldRef (cross-world misuse — a caller bug) ──────────────────
  if (pair.worldRef !== binding.worldRef) {
    return {
      ok: false,
      error: {
        code: 'world-mismatch',
        hint:
          `handle belongs to world ${pair.worldRef} but was used against world ${binding.worldRef} — ` +
          'route the operation to the correct world',
        entity: pair.entity,
        detail: { expectedWorldRef: binding.worldRef, actualWorldRef: pair.worldRef },
      },
    };
  }

  // ── Layer 2: epoch (whole-world reload — batch invalidation) ───────────────
  if (pair.epoch !== binding.epoch) {
    return {
      ok: false,
      error: {
        code: 'stale-entity-handle',
        hint: EPOCH_HINT,
        entity: pair.entity,
        detail: { reason: 'world-epoch-mismatch' },
      },
    };
  }

  // ── Layer 3: engine generation (despawn / recycle in the same world) ───────
  // Name is intrinsic to every live entity; its absence is a reliable liveness
  // probe. Delegate to the engine guard and pass its code through.
  const r = binding.world.get(pair.entity, Name);
  if (!r.ok) {
    const engineCode = (r.error as { code?: string }).code;
    return {
      ok: false,
      error: {
        code: 'stale-entity-handle',
        hint: STALE_HINT,
        entity: pair.entity,
        detail: { reason: 'stale-entity', ...(engineCode ? { engineCode } : {}) },
      },
    };
  }

  return { ok: true, entity: pair.entity };
}
