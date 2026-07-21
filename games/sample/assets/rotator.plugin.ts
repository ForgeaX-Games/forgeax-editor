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

import { defineComponent, defineSystem, Entity } from '@forgeax/engine-ecs';
import type { World } from '@forgeax/engine-ecs';
import { Transform, quat } from '@forgeax/engine-runtime';

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
  // Entity is REQUIRED in `with` for `bundle.Entity.self` (the row count) to be
  // present — buildColumnBundle only emits columns for listed components.
  queries: [{ with: [Rotator, Transform, Entity] }],
  before: ['propagateTransforms'],
  labels: ['transform'],
  fn: (_world: World, queryResults) => {
    for (const bundle of queryResults[0]) {
      const axisCol = bundle.Rotator.axis; // Float32Array, stride 3 per row
      const speedCol = bundle.Rotator.speed; // Float32Array, stride 1
      const quatCol = bundle.Transform.quat; // Float32Array, stride 4 ([x,y,z,w])
      const entities = bundle.Entity.self;

      for (let i = 0; i < entities.length; i++) {
        const speed = speedCol[i] ?? 0;
        const angle = speed * FIXED_DT;
        if (angle === 0) continue;

        const ax = axisCol[i * 3] ?? 0;
        const ay = axisCol[i * 3 + 1] ?? 0;
        const az = axisCol[i * 3 + 2] ?? 0;
        // Zero axis → fromAxisAngle degrades to identity (engine contract): skip.
        if (ax === 0 && ay === 0 && az === 0) continue;

        // deltaQ = rotation of `angle` about `axis`; next = deltaQ * current
        // (Hamilton product) so the spin accumulates on top of the authored pose.
        quat.fromAxisAngle(_delta, [ax, ay, az], angle);
        const q = i * 4;
        _next[0] = quatCol[q] ?? 0;
        _next[1] = quatCol[q + 1] ?? 0;
        _next[2] = quatCol[q + 2] ?? 0;
        _next[3] = quatCol[q + 3] ?? 1;
        quat.multiply(_next, _delta, _next);
        // Renormalize to bleed off float drift over long spins, then write back
        // into the live column buffer (in-place — mutates the ECS store directly).
        quat.normalize(_next, _next);
        quatCol[q] = _next[0]!;
        quatCol[q + 1] = _next[1]!;
        quatCol[q + 2] = _next[2]!;
        quatCol[q + 3] = _next[3]!;
      }
    }
  },
});
