// rotator.plugin.ts — an ASSET-RESIDENT game-logic plugin (no code in main.ts).
//
// This file lives under the game's `assets/` root, NOT compiled into main.ts. The
// editor's game-plugin loader (packages/edit-runtime/src/viewport/game-plugins.ts)
// dynamically imports every `*.plugin.ts` under assets/ via a `/@fs/` URL, so:
//
//   • the `defineComponent` / `defineSystem` calls below run as an import side
//     effect and register into the ONE live engine registry the editor booted
//     (the `gameEngineResolve` vite plugin re-anchors the bare `@forgeax/*`
//     imports to the editor's single engine instance — runtime-vite-preset.ts);
//   • in ✎ Edit the loader registers the COMPONENT only, so you can attach
//     `Rotator` to an entity (e.g. BlueBall) and it round-trips into the scene
//     pack like any builtin component (collect-scene-asset iterates every
//     registered component) — but the system is NOT added to the edit world, so
//     nothing spins while you author;
//   • in ▶ Play the loader ALSO `world.addSystem(rotate)` into the fresh play
//     world, so `rotate` ticks and the entity actually rotates. Which systems a
//     scene runs is DERIVED from which `*.plugin.ts` exist under assets/ — it is
//     not persisted per-scene (Derive, Don't Duplicate).
//
// Authoring contract for a plugin file:
//   - export nothing that must be called; registration happens as an import side
//     effect (defineComponent / defineSystem mutate the global registry).
//   - component + system names are GLOBALLY UNIQUE (the loader fails fast on a
//     duplicate name across plugin files).

import { defineComponent, defineSystem } from '@forgeax/engine-ecs';
import type { World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import { Transform } from '@forgeax/engine-scene';
import {
  GAMEPLAY_PRODUCER_CONTRACT,
  GAMEPLAY_PRODUCER_CONTRACT_VERSION,
  type GamePluginProducer,
} from '@forgeax/engine-app';

// ── Component ────────────────────────────────────────────────────────────────
// A tiny authoring component: spin `speed` radians/second about local `axis`.
// Vector + scalar fields mirror the engine's own PointLight/DirectionalLight
// shape; array<f32,N> defaults MUST be explicit typed arrays (the zero-fallback
// would give a zero axis → no rotation).
export const Rotator = defineComponent('Rotator', {
  axis: { type: 'array<f32, 3>', default: new Float32Array([0, 1, 0]) }, // spin about +Y by default
  speed: { type: 'f32', default: 1 }, // radians per second
});

// Fixed simulation timestep. The engine drives ECS systems from `world.update()`
// WITHOUT threading a per-frame dt (AdvanceAnimationPlayer likewise advances at a
// hardcoded 1/60 — there is no `Time` resource on the live path), so we match
// that fixed-step convention.
const FIXED_DT = 1 / 60;
const SAMPLE_ROTATOR_SPEED_KEY = 'sample.rotator.speed';
const DEFAULT_ROTATOR_SPEED = 1;

// Scratch quats reused across frames (no per-frame allocation in the hot loop).
const _delta = quat.create();
const _next = quat.create();

// ── System ───────────────────────────────────────────────────────────────────
// Query every entity that has BOTH Rotator and Transform; each frame compose an
// incremental axis-angle rotation onto its current quat. Registered
// `before: ['propagateTransforms']` so the new local rotation is folded into the
// entity's world matrix in the SAME frame it is written (otherwise the visible
// rotation lags one frame). `labels: ['transform']` groups it with the transform
// stage for scheduler diagnostics.
export const rotate = defineSystem({
  name: 'rotate',
  queries: [{ read: [Rotator], write: [Transform] }],
  before: ['propagateTransforms'],
  labels: ['transform'],
  fn: (world: World, queryResults) => {
    const globalSpeed = world.hasResource(SAMPLE_ROTATOR_SPEED_KEY)
      ? world.getResource<number>(SAMPLE_ROTATOR_SPEED_KEY)
      : undefined;
    for (const row of queryResults[0]) {
      const rotator = row.get(Rotator);
      const transform = row.mut(Transform);
      const speed = globalSpeed ?? rotator.speed ?? 0;
      const angle = speed * FIXED_DT;
      if (angle === 0) continue;

      const ax = rotator.axis[0] ?? 0;
      const ay = rotator.axis[1] ?? 0;
      const az = rotator.axis[2] ?? 0;
      // Zero axis → fromAxisAngle degrades to identity (engine contract): skip.
      if (ax === 0 && ay === 0 && az === 0) continue;

      // deltaQ = rotation of `angle` about `axis`; next = deltaQ * current
      // (Hamilton product) so the spin accumulates on top of the authored pose.
      quat.fromAxisAngle(_delta, [ax, ay, az], angle);
      _next[0] = transform.quat[0] ?? 0;
      _next[1] = transform.quat[1] ?? 0;
      _next[2] = transform.quat[2] ?? 0;
      _next[3] = transform.quat[3] ?? 1;
      quat.multiply(_next, _delta, _next);
      // Renormalize to bleed off float drift over long spins, then write back
      // through the query's declared mutable Transform row.
      quat.normalize(_next, _next);
      transform.quat[0] = _next[0]!;
      transform.quat[1] = _next[1]!;
      transform.quat[2] = _next[2]!;
      transform.quat[3] = _next[3]!;
    }
  },
});

/**
 * The sample's real game-owned producer. Its descriptor, lifecycle recovery,
 * diagnostics read, and action all travel through the same host carrier as the
 * template game projection; the editor does not special-case this plugin.
 */
export const gameplay: GamePluginProducer = {
  descriptor: {
    contract: GAMEPLAY_PRODUCER_CONTRACT,
    version: GAMEPLAY_PRODUCER_CONTRACT_VERSION,
    id: 'sample.rotator',
    title: 'Sample Rotator Gameplay',
  },
  register: ({ world, gameProjection, lifecycle }) => {
    world.insertResource(SAMPLE_ROTATOR_SPEED_KEY, DEFAULT_ROTATOR_SPEED);

    const removeAction = gameProjection?.registerAction({
      id: 'sample.rotator.set-speed',
      title: 'Set Rotator Speed',
      description: 'Set the shared sample rotator speed in radians per second',
      argsSchema: {
        type: 'object',
        properties: { speed: { type: 'number' } },
        required: ['speed'],
      },
      run: (args) => {
        const speed = typeof args === 'object' && args !== null && !Array.isArray(args)
          ? (args as { speed?: unknown }).speed
          : undefined;
        if (typeof speed !== 'number' || !Number.isFinite(speed)) {
          throw new Error('speed must be a finite number');
        }
        world.insertResource(SAMPLE_ROTATOR_SPEED_KEY, speed);
        return { speed };
      },
    });
    if (removeAction) lifecycle.registerCleanup(removeAction);

    const query = world.query({ with: [Rotator] }).unwrap();
    const removeRead = gameProjection?.registerRead({
      id: 'sample.rotator.state',
      title: 'Sample Rotator State',
      description: 'Current producer-owned speed and Rotator entity count',
      read: () => {
        let rotatorEntities = 0;
        for (const _row of query) rotatorEntities += 1;
        return {
          pluginId: 'sample.rotator',
          contractVersion: GAMEPLAY_PRODUCER_CONTRACT_VERSION,
          speed: world.hasResource(SAMPLE_ROTATOR_SPEED_KEY)
            ? world.getResource<number>(SAMPLE_ROTATOR_SPEED_KEY)
            : DEFAULT_ROTATOR_SPEED,
          rotatorEntities,
        };
      },
    });
    if (removeRead) lifecycle.registerCleanup(removeRead);

    lifecycle.registerReload(() => {
      // Source reload recovery is producer-owned: re-admit the runtime with a
      // deterministic default instead of leaving stale action state behind.
      world.insertResource(SAMPLE_ROTATOR_SPEED_KEY, DEFAULT_ROTATOR_SPEED);
    });
    lifecycle.registerCleanup(() => {
      if (world.hasResource(SAMPLE_ROTATOR_SPEED_KEY)) world.removeResource(SAMPLE_ROTATOR_SPEED_KEY);
    });
  },
};
