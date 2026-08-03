// animation-preview-snapshot.test.ts — snapshot/restore registry unit tests (M1).
//
// The registry (session/animation-preview) is the save-pollution defense: the
// first preview write snapshots the reflection-declared runtimeFields, and the
// save / play / selection-change / scene-teardown boundaries restore or drop
// them. Field classification is DATA-DRIVEN (schema.animation.runtimeFields via
// the editor overlay; engine meta long-term) — these tests pin that behavior
// plus the copy-semantics that keep the world from aliasing the baseline.

import { describe, expect, it, beforeAll, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { AnimationPlayer } from '@forgeax/engine-animation';
import { EngineFacade } from '../io/engine-facade';
import { _resetSchemaCache } from '../scene/schema';
import {
  clearAnimationPreviews,
  hasAnimationPreview,
  previewedAnimationEntities,
  restoreAllAnimationPreviews,
  restoreAnimationPreview,
  restoreAnimationPreviewsOutside,
  snapshotAnimationPreview,
} from '../session/animation-preview';

void AnimationPlayer;

let world: World;
let engine: EngineFacade;

function spawnPlayer(data: Record<string, unknown> = {}): number {
  const r = world.spawn({ component: AnimationPlayer, data });
  if (!r.ok) throw new Error(`spawn failed: ${String(r.error)}`);
  return r.value as unknown as number;
}

function readPlayer(entity: number): Record<string, unknown> {
  const r = world.get(entity as never, AnimationPlayer);
  if (!r.ok) throw new Error('AnimationPlayer read failed');
  return r.value as unknown as Record<string, unknown>;
}

beforeAll(() => {
  _resetSchemaCache();
});

beforeEach(() => {
  clearAnimationPreviews();
  world = new World();
  engine = new EngineFacade(world as never);
});

describe('snapshotAnimationPreview', () => {
  it('snapshots the reflection-declared runtimeFields on first call; first-write-wins', () => {
    const e = spawnPlayer({ paused: true, speeds: [0.5], times: [1.25] });
    expect(snapshotAnimationPreview(engine as never, e)).toBe(true);
    expect(hasAnimationPreview(e)).toBe(true);
    // Second snapshot is a no-op — the authored baseline is already stored.
    expect(snapshotAnimationPreview(engine as never, e)).toBe(false);
  });

  it('copies typed-array fields (no aliasing with the live world column)', () => {
    const e = spawnPlayer({ speeds: [1] });
    snapshotAnimationPreview(engine as never, e);
    // Mutate the world after the snapshot; the baseline must stay [1].
    engine.set(e as never, AnimationPlayer, { speeds: [7] } as never);
    restoreAnimationPreview(engine as never, e);
    expect(Array.from(readPlayer(e).speeds as ArrayLike<number>)[0]).toBe(1);
  });

  it('returns false for an entity without the component', () => {
    const bare = world.spawn();
    if (!bare.ok) throw new Error('spawn failed');
    expect(snapshotAnimationPreview(engine as never, bare.value as unknown as number)).toBe(false);
  });
});

describe('restore boundaries', () => {
  it('restoreAnimationPreview restores authored values and drops the snapshot', () => {
    const e = spawnPlayer({ paused: false });
    snapshotAnimationPreview(engine as never, e);
    engine.set(e as never, AnimationPlayer, { paused: true } as never);
    expect(restoreAnimationPreview(engine as never, e)).toBe(true);
    expect(readPlayer(e).paused).toBe(false);
    expect(hasAnimationPreview(e)).toBe(false);
    // Nothing left to restore.
    expect(restoreAnimationPreview(engine as never, e)).toBe(false);
  });

  it('restoreAllAnimationPreviews restores every snapshotted entity (save/play boundary)', () => {
    const a = spawnPlayer({ paused: false });
    const b = spawnPlayer({ paused: false });
    snapshotAnimationPreview(engine as never, a);
    snapshotAnimationPreview(engine as never, b);
    engine.set(a as never, AnimationPlayer, { paused: true } as never);
    engine.set(b as never, AnimationPlayer, { paused: true } as never);
    expect(restoreAllAnimationPreviews(engine as never)).toBe(2);
    expect(readPlayer(a).paused).toBe(false);
    expect(readPlayer(b).paused).toBe(false);
    expect(previewedAnimationEntities()).toEqual([]);
  });

  it('restoreAnimationPreviewsOutside keeps the current selection, restores the rest', () => {
    const keep = spawnPlayer({ paused: false });
    const leave = spawnPlayer({ paused: false });
    snapshotAnimationPreview(engine as never, keep);
    snapshotAnimationPreview(engine as never, leave);
    engine.set(keep as never, AnimationPlayer, { paused: true } as never);
    engine.set(leave as never, AnimationPlayer, { paused: true } as never);
    expect(restoreAnimationPreviewsOutside(engine as never, new Set([keep]))).toBe(1);
    expect(readPlayer(keep).paused).toBe(true);
    expect(readPlayer(leave).paused).toBe(false);
    expect(hasAnimationPreview(keep)).toBe(true);
    expect(hasAnimationPreview(leave)).toBe(false);
  });

  it('clearAnimationPreviews drops snapshots WITHOUT restoring (scene teardown)', () => {
    const e = spawnPlayer({ paused: false });
    snapshotAnimationPreview(engine as never, e);
    engine.set(e as never, AnimationPlayer, { paused: true } as never);
    clearAnimationPreviews();
    expect(hasAnimationPreview(e)).toBe(false);
    expect(readPlayer(e).paused).toBe(true);
  });
});
