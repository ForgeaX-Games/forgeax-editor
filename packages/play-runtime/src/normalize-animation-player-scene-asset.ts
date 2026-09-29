// Play-runtime local copy of editor-core's scene-load AnimationPlayer repair.
// play-runtime must not import `@forgeax/editor-core` (see vfx-runtime.integration.test.ts).

import type { SceneAsset } from '@forgeax/engine-types';

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

function repairAnimationPlayerColumns(scene: SceneAsset): void {
  for (const entity of Object.values(scene.entities ?? {})) {
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
}

/** Clone + repair (for callers that must not mutate cached registry payloads). */
export function normalizeAnimationPlayerSceneAsset(scene: SceneAsset): SceneAsset {
  const normalized = structuredClone(scene);
  repairAnimationPlayerColumns(normalized);
  return normalized;
}

/** Repair cached SceneAsset payload in place before allocSharedRef/instantiate. */
export function normalizeAnimationPlayerSceneAssetInPlace(scene: SceneAsset): void {
  repairAnimationPlayerColumns(scene);
}
