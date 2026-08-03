// scene/animation-slot-sync — AnimationPlayer parallel-column length sync.
//
// Engine contract (engine/animation-player.ts D-5): clips / times / weights /
// speeds are VARIABLE array columns the ECS layer cannot cross-check — consumers
// MUST write all four at the same length every time, else advanceAnimationPlayer
// rejects the row with `animation-player-slot-length-mismatch`.
//
// bindAssetRef grows `clips` (slot bind pads with zeros to the slot index), which
// leaves times/weights/speeds short. This module computes the one compensating
// patch: pad times with 0, speeds with 1, weights with 0 — then activate (1) the
// weight of each newly bound slot so the clip plays immediately. Pure logic over
// an injected read/dispatch face, so the CI test drives it without a live world.

import type { SceneAsset } from '@forgeax/engine-types';

export interface AnimationSlotSyncIo {
  /** Read one component field's live value (plain array or typed array). */
  readField(entity: number, component: string, field: string): unknown;
  /** Write the compensating patch through the document door. */
  dispatchSetComponent(entity: number, component: string, patch: Record<string, number[]>): void;
}

function readNumbers(raw: unknown): number[] {
  if (Array.isArray(raw)) return [...(raw as number[])];
  if (ArrayBuffer.isView(raw)) return Array.from(raw as unknown as ArrayLike<number>);
  return [];
}

/** Pad (or trim) `col` to length `n` with `fill` for the tail. */
function fitLength(col: number[], n: number, fill: number): number[] {
  const out = col.slice(0, n);
  while (out.length < n) out.push(fill);
  return out;
}

function arrayValues(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return [...raw];
  if (ArrayBuffer.isView(raw)) return Array.from(raw as unknown as ArrayLike<unknown>);
  return [];
}

/**
 * Repair the legacy/externally-authored AnimationPlayer shape at the scene-load
 * boundary. Gateway writes already complete grouped arrays, but a pack produced
 * before that contract (or by a non-editor producer) can still contain
 * `clips=[handle]` with empty runtime columns. The engine is intentionally strict
 * and rejects that shape during its first update; normalize before instantiate so
 * Edit, nested mounts, and Play all see one valid scene payload. The returned
 * asset is a clone because AssetRegistry payloads are cached and shared.
 */
export function normalizeAnimationPlayerSceneAsset(scene: SceneAsset): SceneAsset {
  const normalized = structuredClone(scene);
  for (const entity of normalized.entities ?? []) {
    const components = entity.components as Record<string, unknown> | undefined;
    const raw = components?.AnimationPlayer;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const player = raw as Record<string, unknown>;
    const hasSlotField = ['clips', 'times', 'weights', 'speeds'].some((key) => key in player);
    if (!hasSlotField) continue;

    const clips = arrayValues(player.clips);
    const count = clips.length;
    player.clips = clips;
    player.times = fitLength(arrayValues(player.times) as number[], count, 0);
    player.weights = fitLength(arrayValues(player.weights) as number[], count, 1);
    player.speeds = fitLength(arrayValues(player.speeds) as number[], count, 1);
  }
  return normalized;
}

/** Compute the patch that re-syncs times/weights/speeds to the live clips
 *  length, activating weights for newly bound slots. Returns null when the
 *  columns already satisfy the contract (no compensating write needed). */
export function planAnimationSlotSync(
  io: AnimationSlotSyncIo,
  entity: number,
  boundHandles: readonly number[],
  slot: number | undefined,
  component = 'AnimationPlayer',
): Record<string, number[]> | null {
  const clips = readNumbers(io.readField(entity, component, 'clips'));
  const n = clips.length;
  if (n === 0) return null;

  const times = readNumbers(io.readField(entity, component, 'times'));
  const weights = readNumbers(io.readField(entity, component, 'weights'));
  const speeds = readNumbers(io.readField(entity, component, 'speeds'));

  const patch: Record<string, number[]> = {};
  if (times.length !== n) patch.times = fitLength(times, n, 0);
  if (speeds.length !== n) patch.speeds = fitLength(speeds, n, 1);

  const nextWeights = fitLength(weights, n, 0);
  let weightsChanged = weights.length !== n;
  if (slot !== undefined) {
    if ((nextWeights[slot] ?? 0) === 0) { nextWeights[slot] = 1; weightsChanged = true; }
  } else {
    for (let i = 0; i < boundHandles.length; i++) {
      if (boundHandles[i] !== 0 && (nextWeights[i] ?? 0) === 0) { nextWeights[i] = 1; weightsChanged = true; }
    }
  }
  if (weightsChanged) patch.weights = nextWeights;

  return Object.keys(patch).length > 0 ? patch : null;
}

/** Plan + write. Best-effort by contract: a read/dispatch failure must never
 *  block the bind that triggered the sync. Returns true when a patch was written. */
export function syncAnimationSlotColumns(
  io: AnimationSlotSyncIo,
  entity: number,
  boundHandles: readonly number[],
  slot: number | undefined,
  component = 'AnimationPlayer',
): boolean {
  try {
    const patch = planAnimationSlotSync(io, entity, boundHandles, slot, component);
    if (patch === null) return false;
    io.dispatchSetComponent(entity, component, patch);
    return true;
  } catch {
    return false;
  }
}
