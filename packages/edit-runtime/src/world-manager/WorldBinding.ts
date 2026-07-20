// WorldBinding — a (worldRef, world, epoch) triple, the SSOT for "which world +
// which generation of it" a super-managed handle is bound to (plan-strategy §2
// D-4/D-5).
//
// feat-20260709-editor-world-partition-editorworld-super-composite / M4 (w18) +
// M5 (w28).
//
// A WorldBinding names one engine World, its stable worldRef index, plus a
// monotonic `epoch`. The epoch is a world-manager-side counter (NOT engine state
// — D-4): bumping it on a scene reload lets every super-held handle for that
// world be invalidated with a single comparison ("integer batch invalidation"),
// instead of walking each handle through engine generation checks.
//
// M5 (w28): the epoch STATE + its mutation live in WorldBindingRegistry (this
// file) — the single source (D-5: SSOT in world-manager, no double-write). The
// WorldManager owns exactly one registry; getWorldBinding reads it and bumpEpoch
// mutates it. The binding OBJECT is derived on read so it always carries the
// registry's current epoch (Derive, don't duplicate).
//
// worldRef is the STABLE index a HandlePair carries to name its world (0 =
// editorWorld, 1 = sceneWorld) — the same indices the drawSource feeds as
// cameraOwner / resourceOwner (D-3). Keeping worldRef == drawSource index is the
// Derive discipline: one numbering, no second mapping to keep in sync. It also
// makes a WorldBinding structurally a `HandlePairBinding` (core), so
// validateHandlePair consumes it directly.
//
// Anchors:
//   plan-strategy §2 D-4 (worldRef + epoch + engine generation three-layer)
//   plan-strategy §2 D-5 (epoch counter SSOT in world-manager)
//   requirements S5 (super carries selection handle-pairs / epoch)
//   requirements AC-05 (scene reload handle batch invalidation — RED LINE)

import type { World } from '@forgeax/engine-ecs';

/** The stable world-reference indices super uses. Equal to the drawSource owner
 *  indices (D-3): editorWorld feeds cameraOwner=0, sceneWorld feeds resourceOwner=1. */
export const WORLD_REF_EDITOR = 0 as const;
export const WORLD_REF_SCENE = 1 as const;

/** A world plus its worldRef and current epoch. Structurally a core
 *  `HandlePairBinding` (worldRef, epoch, world), so validateHandlePair reads it
 *  directly. Derived on read from the registry — never stored independently. */
export interface WorldBinding {
  /** Stable world reference (0 = editorWorld, 1 = sceneWorld). */
  readonly worldRef: number;
  /** The engine World this binding names. */
  readonly world: World;
  /** Monotonic generation counter for batch handle invalidation (D-4). */
  readonly epoch: number;
}

/**
 * The SSOT for per-worldRef epoch counters (D-5). WorldManager owns one instance;
 * a scene reload bumps the sceneWorld epoch so every handle-pair minted at the
 * prior epoch is invalidated in one comparison. Editor epoch never bumps in
 * practice (editorWorld lives for the manager's lifetime), but the registry
 * treats all worldRefs uniformly.
 */
export class WorldBindingRegistry {
  /** worldRef -> current epoch. Absent key reads as epoch 0. */
  private readonly _epochs = new Map<number, number>();

  /** Current epoch for a worldRef (0 if never bumped). */
  epoch(worldRef: number): number {
    return this._epochs.get(worldRef) ?? 0;
  }

  /** Advance a worldRef's epoch by one (batch-invalidates all its prior pairs). */
  bump(worldRef: number): void {
    this._epochs.set(worldRef, this.epoch(worldRef) + 1);
  }

  /** Derive a binding object for (worldRef, world) at the registry's live epoch. */
  binding(worldRef: number, world: World): WorldBinding {
    return { worldRef, world, epoch: this.epoch(worldRef) };
  }
}
