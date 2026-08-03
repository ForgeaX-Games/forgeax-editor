// animation-slot-sync.test.ts — AnimationPlayer parallel-column length sync.
//
// Regression pin (animation-preview M1 quick-fix): bindAssetRef grows/pads the
// clips column; the engine's D-5 parallel-length contract demands times /
// weights / speeds match it exactly or advanceAnimationPlayer rejects the row
// (`animation-player-slot-length-mismatch`). The compensating patch logic is
// pure (scene/animation-slot-sync) — this suite drives it with a fake IO face.

import { describe, expect, it } from 'bun:test';
import { AnimationPlayer, advanceAnimationPlayer } from '@forgeax/engine-animation';
import { World } from '@forgeax/engine-ecs';
import type { SceneAsset } from '@forgeax/engine-types';
import {
  normalizeAnimationPlayerSceneAsset,
  planAnimationSlotSync,
  syncAnimationSlotColumns,
  type AnimationSlotSyncIo,
} from '../scene/animation-slot-sync';

function fakeIo(fields: Record<string, unknown>): AnimationSlotSyncIo & { written: Record<string, number[]>[] } {
  const written: Record<string, number[]>[] = [];
  return {
    written,
    readField: (_e, _c, field) => fields[field],
    dispatchSetComponent: (_e, _c, patch) => { written.push(patch); },
  };
}

describe('normalizeAnimationPlayerSceneAsset', () => {
  it('repairs legacy parallel columns without mutating the cached payload', () => {
    const source = {
      kind: 'scene',
      entities: [{
        localId: 0,
        components: {
          AnimationPlayer: {
            clips: ['clip-guid'],
            times: [],
            weights: [],
            speeds: [],
            looping: true,
          },
        },
      }],
    } as unknown as SceneAsset;

    const normalized = normalizeAnimationPlayerSceneAsset(source);
    const player = normalized.entities[0]?.components.AnimationPlayer as Record<string, unknown>;
    const originalPlayer = source.entities[0]?.components.AnimationPlayer as Record<string, unknown>;
    expect(player.times).toEqual([0]);
    expect(player.weights).toEqual([1]);
    expect(player.speeds).toEqual([1]);
    expect(originalPlayer.times).toEqual([]);
    expect(originalPlayer.weights).toEqual([]);
    expect(originalPlayer.speeds).toEqual([]);
  });

  it('trims stale runtime columns when a legacy payload has too many slots', () => {
    const scene = {
      kind: 'scene',
      entities: [{
        localId: 0,
        components: {
          AnimationPlayer: { clips: ['clip-guid'], times: [0, 1], weights: [1, 0], speeds: [1, 2] },
        },
      }],
    } as unknown as SceneAsset;

    const player = normalizeAnimationPlayerSceneAsset(scene).entities[0]?.components.AnimationPlayer as Record<string, unknown>;
    expect(player.times).toEqual([0]);
    expect(player.weights).toEqual([1]);
    expect(player.speeds).toEqual([1]);
  });

  it('makes a legacy one-clip payload safe for the engine first update', () => {
    const scene = {
      kind: 'scene',
      entities: [{
        localId: 0,
        components: {
          AnimationPlayer: { clips: ['clip-guid'], times: [], weights: [], speeds: [] },
        },
      }],
    } as unknown as SceneAsset;
    const normalizedPlayer = normalizeAnimationPlayerSceneAsset(scene)
      .entities[0]?.components.AnimationPlayer as Record<string, unknown>;

    const world = new World();
    const clip = world.allocSharedRef('AnimationClip', {
      kind: 'animation-clip',
      duration: 1,
      channels: [],
    });
    world.spawn({
      component: AnimationPlayer,
      data: {
        clips: [clip],
        times: normalizedPlayer.times as number[],
        weights: normalizedPlayer.weights as number[],
        speeds: normalizedPlayer.speeds as number[],
      },
    }).unwrap();

    expect(() => advanceAnimationPlayer(world, 0.1)).not.toThrow();
  });
});

describe('planAnimationSlotSync', () => {
  it('pads times/weights/speeds to the clips length and activates the bound slot', () => {
    // clips grew to length 1 by the slot bind; the other columns are still empty.
    const io = fakeIo({ clips: [1025], times: [], weights: [], speeds: [] });
    const patch = planAnimationSlotSync(io, 7, [1025], 0);
    expect(patch).toEqual({ times: [0], speeds: [1], weights: [1] });
  });

  it('whole-field binds activate every newly bound slot (handles list)', () => {
    const io = fakeIo({ clips: [11, 22], times: [], weights: [], speeds: [] });
    const patch = planAnimationSlotSync(io, 7, [11, 22], undefined);
    expect(patch).toEqual({ times: [0, 0], speeds: [1, 1], weights: [1, 1] });
  });

  it('keeps authored values on already-synced columns; only activates the new slot', () => {
    const io = fakeIo({
      clips: [11, 22],
      times: new Float32Array([0.4, 0.8]),
      weights: new Float32Array([1, 0]),
      speeds: new Float32Array([2, 2]),
    });
    const patch = planAnimationSlotSync(io, 7, [22], 1);
    // Lengths already match — only the slot-1 weight activation is written.
    expect(patch).toEqual({ weights: [1, 1] });
  });

  it('trims over-long columns down to the clips length', () => {
    const io = fakeIo({ clips: [11], times: [0.1, 0.2, 0.3], weights: [1, 0, 0], speeds: [1, 1, 1] });
    const patch = planAnimationSlotSync(io, 7, [11], undefined);
    expect(patch?.times).toEqual([0.1]);
    expect(patch?.speeds).toEqual([1]);
  });

  it('returns null when every column already satisfies the contract', () => {
    const io = fakeIo({ clips: [11], times: [0], weights: [1], speeds: [1] });
    expect(planAnimationSlotSync(io, 7, [11], 0)).toBeNull();
  });

  it('returns null for an empty clips column (nothing to sync to)', () => {
    const io = fakeIo({ clips: [], times: [], weights: [], speeds: [] });
    expect(planAnimationSlotSync(io, 7, [11], 0)).toBeNull();
  });
});

describe('syncAnimationSlotColumns', () => {
  it('writes the planned patch through the injected document door', () => {
    const io = fakeIo({ clips: [1025], times: [], weights: [], speeds: [] });
    expect(syncAnimationSlotColumns(io, 7, [1025], 0)).toBe(true);
    expect(io.written).toEqual([{ times: [0], speeds: [1], weights: [1] }]);
  });

  it('best-effort: a throwing read never blocks the caller', () => {
    const io: AnimationSlotSyncIo = {
      readField: () => { throw new Error('world gone'); },
      dispatchSetComponent: () => {},
    };
    expect(syncAnimationSlotColumns(io, 7, [1], 0)).toBe(false);
  });
});
