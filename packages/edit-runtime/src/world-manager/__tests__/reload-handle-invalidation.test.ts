// reload-handle-invalidation.test.ts (w23) — E1: scene reload batch-invalidates
// every super-held sceneWorld handle pair; selection is cleared with an
// observable UI signal (test-first RED, impl w26/w28/w29).
//
// feat-20260709-editor-world-partition-editorworld-super-composite / M5.
//
// requirements E1 / AC-05 (RED LINE): after a scene reload, the super layer's
// sceneWorld handle pairs must ALL become invalid (not one-by-one), the
// selection / inspector bindings must batch-clear, and no handle pointing at the
// pre-reload world may linger. The mechanism (plan D-4): world-manager holds an
// epoch counter per world; the scene-reload collar (gateway.replaceDoc) fires a
// reload event; WorldManager.attach() bumps the scene epoch and revalidates the
// selection, so every pair minted at the prior epoch fails the epoch layer of
// validateHandlePair in one comparison.
//
// This is an INTEGRATION test of the real seam: it drives selection through the
// live gateway, triggers the reload through gateway.replaceDoc (the SSOT collar),
// and asserts the observable outcome. RED until w26 (selection→HandlePair) +
// w28 (epoch + reload hook) + w29 (WorldManager.attach wiring) land.
//
// Anchors:
//   requirements E1 (scene reload → super scene handles batch-invalidate;
//     selection/inspector batch-clear with observable UI feedback; no residual
//     handle pointing at the old world)
//   requirements AC-05 (scene reload handle batch invalidation — RED LINE)
//   plan-strategy §2 D-4 (world-manager bumps scene binding epoch at the
//     replaceDoc / scene-reload collar → batch invalidation)

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { Name } from '@forgeax/engine-runtime';
import type { EntityHandle } from '@forgeax/engine-ecs';
import {
  gateway,
  createEditSession,
  getSelection,
  getSelectionList,
  getSelectionPair,
  validateHandlePair,
  type HandlePair,
} from '@forgeax/editor-core';
import { WorldManager, WORLD_REF_SCENE } from '../index';

function spawnNamed(world: World, name: string): EntityHandle {
  const r = world.spawn({ component: Name, data: { value: name } });
  if (!r.ok) throw new Error(`spawn failed: ${name}`);
  return r.value;
}

// clearSelection is a submodule-level lifecycle seam (not on the barrel); reset
// via the public setSelection(null) dispatch instead.
function resetSelection(): void {
  gateway.dispatch({ kind: 'setSelection', id: null } as never);
}

describe('w23 — scene reload batch-invalidates super scene handle pairs', () => {
  beforeEach(() => {
    resetSelection();
  });
  afterEach(() => {
    resetSelection();
  });

  it('reload bumps the scene epoch, batch-invalidates every pair, and clears selection', () => {
    const sceneWorld = new World();
    const e1 = spawnNamed(sceneWorld, 'authored-a');
    const e2 = spawnNamed(sceneWorld, 'authored-b');

    const wm = new WorldManager(() => sceneWorld);
    const detach = wm.attach();
    try {
      // Scene binding starts at epoch 0.
      const before = wm.getWorldBinding(WORLD_REF_SCENE);
      expect(before?.epoch).toBe(0);

      // Select two scene entities through the live gateway — the selection store
      // mints HandlePairs against the current (worldRef=scene, epoch=0) binding.
      gateway.dispatch({ kind: 'setSelectionMany', ids: [e1, e2] } as never);
      expect(getSelectionList().size).toBe(2);
      expect(getSelection()).toBe(e2);

      // Capture the primary pair so we can prove the epoch layer rejects it.
      const stalePair = getSelectionPair() as HandlePair;
      expect(stalePair).not.toBeNull();
      expect(stalePair.worldRef).toBe(WORLD_REF_SCENE);
      expect(stalePair.epoch).toBe(0);

      // ── The reload: the SSOT collar (gateway.replaceDoc) fires the scene-
      // reload event → WorldManager bumps the scene epoch + revalidates. ──
      gateway.replaceDoc(createEditSession());

      // (a) epoch advanced → one-comparison batch invalidation.
      const after = wm.getWorldBinding(WORLD_REF_SCENE);
      expect(after?.epoch).toBe(1);

      // (b) the pre-reload pair now fails the epoch layer of the three-layer
      //     check with the batch-invalidation reason (validated against the NEW
      //     binding — proves it is the epoch, not a despawn, that killed it).
      const v = validateHandlePair(stalePair, after!);
      expect(v.ok).toBe(false);
      if (!v.ok && v.error.code === 'stale-entity-handle') {
        expect(v.error.detail.reason).toBe('world-epoch-mismatch');
      } else {
        throw new Error(`expected stale-entity-handle, got ${v.ok ? 'ok' : v.error.code}`);
      }

      // (c) selection batch-cleared (observable UI signal): store empty,
      //     getSelection() === null, no residual pair.
      expect(getSelectionList().size).toBe(0);
      expect(getSelection()).toBeNull();
      expect(getSelectionPair()).toBeNull();
    } finally {
      detach();
    }
  });

  it('no residual handle pointing at the old world survives reload', () => {
    const sceneWorld = new World();
    const e = spawnNamed(sceneWorld, 'only');
    const wm = new WorldManager(() => sceneWorld);
    const detach = wm.attach();
    try {
      gateway.dispatch({ kind: 'setSelection', id: e } as never);
      expect(getSelection()).toBe(e);

      gateway.replaceDoc(createEditSession());

      // The selection list holds NOTHING from the pre-reload world.
      const list = getSelectionList();
      expect(list.size).toBe(0);
      expect(list.has(e)).toBe(false);
    } finally {
      detach();
    }
  });
});
