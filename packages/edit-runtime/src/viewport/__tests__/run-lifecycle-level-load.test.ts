// run-lifecycle-level-load.test.ts (w6) — headless full-chain play->stop->play.
//
// feat-20260707-editor-world-fork-ssot-level-load-play-activeworld M2.
//
// This is the R-N1 falsification test + the AC-04/05/06/07 headless regression.
// It drives the REAL engine assemble path (createApp assemble form + real
// `new World()` + real instantiateScene) with a FAKE renderer, so the one thing
// it proves that a compile-only check cannot: the engine frame loop calls
// `renderer.draw(playWorld)` with the FRESH play world (R-N1 — no hidden
// single-world binding in the renderer contract). The renderer contract is
// `draw(world)` per-call (D-1), so a shared host-owned renderer legitimately
// draws two mutually exclusive worlds.
//
// It also proves:
//   - AC-04: play = fresh new World() + assemble + defaultScene loadByGuid path +
//     instantiateScene + bootstrap (level-load, single path).
//   - AC-05: play->stop->play is idempotent; after stop the lifecycle holds NO
//     reference to the discarded play world (GC-reachability proxy = currentPlayWorld()
//     returns null); the shared renderer is NOT disposed on stop (dispose-shield).
//   - AC-06/07: editorApp.pause() on play (editWorld zero tick) + resume() on stop.
//   - AC-05 dead-concept sweep: `epoch` and the 4-layer undo vocabulary are gone
//     from run-lifecycle.ts source (grep zero hits).
//
// bun has no requestAnimationFrame, so the engine frame loop never self-schedules;
// the test installs a capturing fake rAF to step exactly one frame deterministically.
//
// Anchors:
//   plan-strategy §5.5 (M2 sweep must include a real full-chain command)
//   plan-strategy D-1 (renderer.draw(world) per-call) / D-2 (pause<->start/stop) /
//     D-7 (assemble plugin set) / R-N1 (draw(playWorld) production check)
//   requirements AC-04/AC-05/AC-06/AC-07

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import type { BootstrapContext, GameProjectionRegistrar } from '@forgeax/engine-app';
import { Name } from '@forgeax/engine-runtime';
import {
  addOnEnter,
  defineState,
  despawnOnExit,
  getState,
  setNextState,
  type StateToken,
} from '@forgeax/engine-state';
import { EditGateway, createEditSession } from '@forgeax/editor-core';
import { assemblePlayWorld, type PlayAssembly } from '../play-assemble';
import { createRunLifecycle } from '../run-lifecycle';

type EcsWorld = InstanceType<typeof World>;

// ── Fake rAF harness — capture the scheduled callback so tests step frames. ──
function installFakeRaf() {
  const g = globalThis as unknown as {
    requestAnimationFrame?: (cb: (t: number) => void) => number;
    cancelAnimationFrame?: (id: number) => void;
  };
  const prevRaf = g.requestAnimationFrame;
  const prevCaf = g.cancelAnimationFrame;
  let captured: ((t: number) => void) | null = null;
  g.requestAnimationFrame = (cb: (t: number) => void) => {
    captured = cb;
    return 1;
  };
  g.cancelAnimationFrame = () => {
    captured = null;
  };
  return {
    step(t = 16): void {
      const cb = captured;
      captured = null; // one-shot: the loop re-arms by calling rAF again
      cb?.(t);
    },
    restore(): void {
      g.requestAnimationFrame = prevRaf;
      g.cancelAnimationFrame = prevCaf;
    },
  };
}

// ── Fake renderer — records draw(world) targets; dispose is observable. ──
// `assets.instantiate` is the AssetRegistry seam play-assemble routes the
// defaultScene through (GUID→handle resolve + spawn). It's a recording spy here:
// the lifecycle tests don't assert on spawned scene entities, and the dedicated
// regression test below asserts play uses THIS spy, never the raw
// world.instantiateScene (the SharedRefReleasedError bug).
function makeFakeRenderer() {
  const drawWorlds: unknown[] = [];
  const instantiateCalls: Array<{ handle: unknown; world: unknown }> = [];
  let disposeCalls = 0;
  const renderer = {
    ready: Promise.resolve({ ok: true }),
    assets: {
      instantiate(handle: unknown, world: unknown) {
        instantiateCalls.push({ handle, world });
        return { ok: true as const, value: 1 };
      },
    },
    // Engine #643 migrated the frame loop to composited multi-world rendering:
    // renderer.draw(worlds, { owner }) takes an ARRAY of worlds. Record each
    // drawn world (flattened) so the per-world assertions below still hold.
    draw(worlds: unknown, _opts?: unknown) {
      if (Array.isArray(worlds)) drawWorlds.push(...worlds);
      else drawWorlds.push(worlds);
      return { ok: true } as const;
    },
    dispose() {
      disposeCalls += 1;
    },
    onError(_cb: (e: unknown) => void) {
      return () => {};
    },
  };
  return {
    renderer,
    drawWorlds,
    instantiateCalls,
    get disposeCalls() {
      return disposeCalls;
    },
  };
}

// A minimal SceneAsset instantiable headlessly (same shape as snapshot-native).
// NOTE: no MeshFilter / shared<> handle field — so this asset alone does NOT
// exercise the GUID→handle resolve step. makeSceneAssetWithHandle() below covers
// the real production shape (the SharedRefReleasedError regression).
function makeSceneAsset() {
  return {
    kind: 'scene' as const,
    entities: [
      { localId: 0, components: { Transform: { pos: [0, 0, 0], scale: [1, 1, 1] }, Name: { value: 'Root' } } },
      { localId: 1, components: { Transform: { pos: [1, 0, 0], scale: [1, 1, 1] }, Name: { value: 'Child' } } },
    ],
  };
}

// A SceneAsset carrying a MeshFilter.assetHandle as a GUID STRING — the shape
// parseScenePayload produces after resolving on-disk refs[] indices. Only the
// AssetRegistry.instantiate spine (renderer.assets.instantiate → _resolveSceneGuids)
// can turn this into a live per-world numeric handle; the raw world.instantiateScene
// would feed the GUID string into the numeric shared-ref retain path and throw
// SharedRefReleasedError. This is the production case the level-load smoke missed.
function makeSceneAssetWithHandle() {
  return {
    kind: 'scene' as const,
    entities: [
      {
        localId: 0,
        components: {
          Transform: { pos: [0, 0, 0], scale: [1, 1, 1] },
          Name: { value: 'Ground' },
          MeshFilter: { assetHandle: 'cbe42beb-8975-5096-b3a1-3dda4cb4c077' },
        },
      },
    ],
  };
}

// A fake game module bootstrap that records the world it received.
function makeFakeBootstrap() {
  let bootstrapWorld: unknown = null;
  let bootstrapCount = 0;
  const entry = (world: unknown, _ctx?: unknown) => {
    bootstrapWorld = world;
    bootstrapCount += 1;
  };
  return {
    entry,
    get bootstrapWorld() {
      return bootstrapWorld;
    },
    get bootstrapCount() {
      return bootstrapCount;
    },
  };
}

// A fake editorApp that records pause/resume so AC-07 (editWorld freeze) is asserted.
function makeFakeEditorApp() {
  const calls: string[] = [];
  return {
    calls,
    pause() {
      calls.push('pause');
      return { ok: true } as const;
    },
    resume() {
      calls.push('resume');
      return { ok: true } as const;
    },
  };
}

// A fake gateway recording enterPlay/exitPlay + the world it was handed.
// Also records the round-8 #3 play-attempt observability signals so a test can
// assert playSimulation() marks 'starting' up front and 'failed' on a degraded
// assemble (the front-door terminal signal the real EditGateway exposes).
function makeFakeGateway() {
  const events: Array<{ kind: string; world?: unknown; error?: unknown }> = [];
  return {
    events,
    enterPlay(world: unknown) {
      events.push({ kind: 'enterPlay', world });
    },
    exitPlay() {
      events.push({ kind: 'exitPlay' });
    },
    beginPlayAttempt() {
      events.push({ kind: 'beginPlayAttempt' });
    },
    failPlayAttempt(error: unknown) {
      events.push({ kind: 'failPlayAttempt', error });
    },
  };
}

/** Build a lifecycle whose `assemble` runs the REAL engine assemble path against a
 *  fake renderer + fresh new World() + real instantiateScene of a minimal asset. */
function buildRealAssembleLifecycle() {
  const fr = makeFakeRenderer();
  const editorApp = makeFakeEditorApp();
  const gateway = makeFakeGateway();
  const boot = makeFakeBootstrap();
  const assembledWorlds: EcsWorld[] = [];

  const assemble = async (): Promise<{ ok: true; value: PlayAssembly } | { ok: false; error: unknown }> =>
    assemblePlayWorld({
      renderer: fr.renderer as never,
      loadDefaultScene: async () => makeSceneAsset(),
      resolveBootstrap: async () => boot.entry as never,
      // headless: no canvas → skip real DOM input attach (returns no detach).
      attachInput: (world: unknown) => {
        assembledWorlds.push(world as EcsWorld);
        return undefined;
      },
      newWorld: () => new World() as never,
    });

  const lifecycle = createRunLifecycle({
    editorApp: editorApp as never,
    gateway: gateway as never,
    assemble: assemble as never,
  });

  return { lifecycle, fr, editorApp, gateway, boot, assembledWorlds };
}

describe('w6 — headless full-chain play->stop->play (level-load, R-N1)', () => {
  it('(R-N1) engine frame loop calls renderer.draw(playWorld) with the fresh play world', async () => {
    const fakeRaf = installFakeRaf();
    try {
      const t = buildRealAssembleLifecycle();
      await t.lifecycle.playSimulation();
      const playWorld = t.lifecycle.currentPlayWorld();
      expect(playWorld).not.toBeNull();
      // Step one frame: the started playApp draws the play world.
      fakeRaf.step();
      expect(t.fr.drawWorlds.length).toBeGreaterThanOrEqual(1);
      expect(t.fr.drawWorlds[t.fr.drawWorlds.length - 1]).toBe(playWorld);
      t.lifecycle.stopSimulation();
    } finally {
      fakeRaf.restore();
    }
  });

  it('(AC-04) play assembles a FRESH world + runs bootstrap on it', async () => {
    const fakeRaf = installFakeRaf();
    try {
      const t = buildRealAssembleLifecycle();
      await t.lifecycle.playSimulation();
      const playWorld = t.lifecycle.currentPlayWorld();
      expect(t.boot.bootstrapCount).toBe(1);
      expect(t.boot.bootstrapWorld).toBe(playWorld);
      // enterPlay handed the gateway the SAME fresh world (single pointer, D-3).
      const enter = t.gateway.events.find((e) => e.kind === 'enterPlay');
      expect(enter?.world).toBe(playWorld);
      t.lifecycle.stopSimulation();
    } finally {
      fakeRaf.restore();
    }
  });

  it('(AC-07) play pauses editorApp; stop resumes it', async () => {
    const fakeRaf = installFakeRaf();
    try {
      const t = buildRealAssembleLifecycle();
      await t.lifecycle.playSimulation();
      expect(t.editorApp.calls).toContain('pause');
      expect(t.editorApp.calls).not.toContain('resume');
      t.lifecycle.stopSimulation();
      expect(t.editorApp.calls).toEqual(['pause', 'resume']);
    } finally {
      fakeRaf.restore();
    }
  });

  it('(AC-05) stop does NOT dispose the shared renderer (dispose-shield)', async () => {
    const fakeRaf = installFakeRaf();
    try {
      const t = buildRealAssembleLifecycle();
      await t.lifecycle.playSimulation();
      t.lifecycle.stopSimulation();
      expect(t.fr.disposeCalls).toBe(0);
    } finally {
      fakeRaf.restore();
    }
  });

  it('(AC-05) after stop the lifecycle drops the play world reference (GC reachability)', async () => {
    const fakeRaf = installFakeRaf();
    try {
      const t = buildRealAssembleLifecycle();
      await t.lifecycle.playSimulation();
      expect(t.lifecycle.currentPlayWorld()).not.toBeNull();
      t.lifecycle.stopSimulation();
      expect(t.lifecycle.currentPlayWorld()).toBeNull();
      t.gateway.events.some((e) => e.kind === 'exitPlay');
      expect(t.gateway.events.some((e) => e.kind === 'exitPlay')).toBe(true);
    } finally {
      fakeRaf.restore();
    }
  });

  it('(AC-05) play->stop->play is idempotent — a fresh world each play, exit each stop', async () => {
    const fakeRaf = installFakeRaf();
    try {
      const t = buildRealAssembleLifecycle();
      await t.lifecycle.playSimulation();
      const w1 = t.lifecycle.currentPlayWorld();
      t.lifecycle.stopSimulation();

      await t.lifecycle.playSimulation();
      const w2 = t.lifecycle.currentPlayWorld();
      t.lifecycle.stopSimulation();

      expect(w1).not.toBeNull();
      expect(w2).not.toBeNull();
      expect(w2).not.toBe(w1); // fresh world each play (level-load, not restore)
      expect(t.boot.bootstrapCount).toBe(2);
      // two enterPlay + two exitPlay, balanced.
      expect(t.gateway.events.filter((e) => e.kind === 'enterPlay').length).toBe(2);
      expect(t.gateway.events.filter((e) => e.kind === 'exitPlay').length).toBe(2);
      // renderer survived both cycles.
      expect(t.fr.disposeCalls).toBe(0);
    } finally {
      fakeRaf.restore();
    }
  });

  it('(idempotent) a stray second stop with no play is a no-op', async () => {
    const fakeRaf = installFakeRaf();
    try {
      const t = buildRealAssembleLifecycle();
      await t.lifecycle.playSimulation();
      t.lifecycle.stopSimulation();
      const resumeCount1 = t.editorApp.calls.filter((c) => c === 'resume').length;
      t.lifecycle.stopSimulation(); // stray
      const resumeCount2 = t.editorApp.calls.filter((c) => c === 'resume').length;
      expect(resumeCount2).toBe(resumeCount1); // no extra resume
    } finally {
      fakeRaf.restore();
    }
  });
});

// ── Game-owned projection: bootstrap → live Gateway → Stop cleanup ──────────
// The game names and implements the action/read behavior. The editor host only
// passes the registrar during bootstrap, installs it after enterPlay, and clears it
// before dropping the fresh world. This is the P9a-facing seam; it has no LevelId
// or game-specific variants in editor source.
describe('▶ Play game-owned action/read projection', () => {
  it('exposes a bootstrap-owned A→B→A action/read pair only during the live Play run', async () => {
    const fakeRaf = installFakeRaf();
    try {
      const doc = createEditSession();
      doc.world = new World();
      const gateway = new EditGateway(doc);
      const fr = makeFakeRenderer();
      const editorApp = makeFakeEditorApp();
      let level = 'a';
      const entry = (_world: unknown, ctx?: { gameProjection?: GameProjectionRegistrar }) => {
        ctx?.gameProjection?.registerAction({
          id: 'sample.level.transition',
          title: 'Transition level',
          argsSchema: {
            type: 'object',
            properties: { target: { type: 'string', enum: ['a', 'b'] } },
            required: ['target'],
          },
          run: (args) => { level = (args as { target: string }).target; },
        });
        ctx?.gameProjection?.registerRead({
          id: 'sample.level.status',
          title: 'Read level status',
          read: () => ({ activeLevel: level, rootCount: level === 'a' ? 1 : 2 }),
        });
      };
      const lifecycle = createRunLifecycle({
        editorApp: editorApp as never,
        gateway,
        assemble: async () => assemblePlayWorld({
          renderer: fr.renderer as never,
          loadDefaultScene: async () => makeSceneAsset(),
          resolveBootstrap: async () => entry as never,
          attachInput: () => undefined,
          newWorld: () => new World() as never,
          createGameProjection: () => {
            const registry = gateway.createGameProjectionRegistry();
            return {
              registrar: registry.registrar,
              install: () => gateway.installGameProjection(registry),
              clear: () => gateway.clearGameProjection(),
            };
          },
        }),
      });

      expect(gateway.listGameActions()).toEqual([]);
      await lifecycle.playSimulation();
      expect(gateway.listGameActions().map((item) => item.id)).toEqual(['sample.level.transition']);
      expect(gateway.listGameReads().map((item) => item.id)).toEqual(['frameStats', 'rendererStats', 'sample.level.status']);
      await expect(gateway.invokeGameAction('sample.level.transition', { target: 'b' }))
        .resolves.toEqual({ ok: true, value: undefined });
      await expect(gateway.readGameState('sample.level.status'))
        .resolves.toEqual({ ok: true, value: { activeLevel: 'b', rootCount: 2 } });
      await expect(gateway.invokeGameAction('sample.level.transition', { target: 'a' }))
        .resolves.toEqual({ ok: true, value: undefined });
      await expect(gateway.readGameState('sample.level.status'))
        .resolves.toEqual({ ok: true, value: { activeLevel: 'a', rootCount: 1 } });
      expect(gateway.ledger).toEqual([]);

      lifecycle.stopSimulation();
      expect(gateway.listGameActions()).toEqual([]);
      await expect(gateway.readGameState('sample.level.status'))
        .resolves.toMatchObject({ ok: false, error: { code: 'game-projection-unavailable' } });
    } finally {
      fakeRaf.restore();
    }
  });
});

// ── Game state registration must precede the Play-world state plugin ─────────
// A game defines its StateToken at module scope. The host must resolve that module
// before createApp runs statePlugin(), while still invoking bootstrap only after it
// instantiated the default scene. Otherwise setNextState sees a token with no
// State/NextState resources and fails at runtime with state-not-registered.
describe('▶ Play module-level game state registration', () => {
  function makeStateBootstrap() {
    // This factory models dynamic main.ts evaluation: defineState runs while
    // resolveBootstrap imports the module, before it returns bootstrap.
    const state: StateToken<'RunLifecycleProjectionState', 'a' | 'b'> = defineState(
      'RunLifecycleProjectionState',
      ['a', 'b'] as const,
    );
    return (world: unknown, ctx?: { gameProjection?: GameProjectionRegistrar } & Pick<BootstrapContext, 'registerCleanup'>) => {
      const w = world as World;
      let scoped: EntityHandle | undefined;
      const global = w.spawn({ component: Name, data: { value: 'global' } }).unwrap();
      const removeOnEnter = addOnEnter(state, 'b', (enterWorld) => {
        scoped = enterWorld.spawn({ component: Name, data: { value: 'level-b' } }).unwrap();
        despawnOnExit(enterWorld, scoped, state, 'b');
      });
      ctx?.registerCleanup?.(removeOnEnter);
      ctx?.gameProjection?.registerAction({
        id: 'state.transition',
        title: 'Transition state',
        argsSchema: {
          type: 'object',
          properties: { target: { type: 'string', enum: ['a', 'b'] } },
          required: ['target'],
        },
        run: (args) => {
          const result = setNextState(w, state, (args as { target: 'a' | 'b' }).target);
          if (!result.ok) throw new Error(result.error.code);
        },
      });
      ctx?.gameProjection?.registerRead({
        id: 'state.status',
        title: 'Read state',
        read: () => {
          const current = getState(w, state);
          return {
            active: current.ok ? current.value : 'unavailable',
            globalAlive: w.get(global, Name).ok,
            scopedAlive: scoped !== undefined && w.get(scoped, Name).ok,
            entityCount: w.inspect().entityCount,
          };
        },
      });
    };
  }

  it('registers a bootstrap module StateToken before statePlugin builds the fresh world', async () => {
    const fakeRaf = installFakeRaf();
    try {
      const doc = createEditSession();
      doc.world = new World();
      const gateway = new EditGateway(doc);
      const fr = makeFakeRenderer();
      const editorApp = makeFakeEditorApp();
      // Mirrors a resolved game module: defineState ran once at module evaluation,
      // while the same bootstrap executes for every fresh Play world.
      const entry = makeStateBootstrap();
      const lifecycle = createRunLifecycle({
        editorApp: editorApp as never,
        gateway,
        assemble: async () => assemblePlayWorld({
          renderer: fr.renderer as never,
          loadDefaultScene: async () => makeSceneAsset(),
          resolveBootstrap: async () => entry as never,
          attachInput: () => undefined,
          newWorld: () => new World() as never,
          createGameProjection: () => {
            const registry = gateway.createGameProjectionRegistry();
            return {
              registrar: registry.registrar,
              install: () => gateway.installGameProjection(registry),
              clear: () => gateway.clearGameProjection(),
            };
          },
        }),
      });

      await lifecycle.playSimulation();
      await expect(gateway.invokeGameAction('state.transition', { target: 'b' }))
        .resolves.toEqual({ ok: true, value: undefined });
      fakeRaf.step();
      await expect(gateway.readGameState('state.status'))
        .resolves.toEqual({ ok: true, value: { active: 'b', globalAlive: true, scopedAlive: true, entityCount: 3 } });

      await expect(gateway.invokeGameAction('state.transition', { target: 'a' }))
        .resolves.toEqual({ ok: true, value: undefined });
      fakeRaf.step();
      await expect(gateway.readGameState('state.status'))
        .resolves.toEqual({ ok: true, value: { active: 'a', globalAlive: true, scopedAlive: false, entityCount: 2 } });
      lifecycle.stopSimulation();

      await lifecycle.playSimulation();
      await expect(gateway.invokeGameAction('state.transition', { target: 'b' }))
        .resolves.toEqual({ ok: true, value: undefined });
      fakeRaf.step();
      await expect(gateway.readGameState('state.status'))
        .resolves.toEqual({ ok: true, value: { active: 'b', globalAlive: true, scopedAlive: true, entityCount: 3 } });
      lifecycle.stopSimulation();
    } finally {
      fakeRaf.restore();
    }
  });
});

// ── Regression: ▶ Play must resolve GUID-string handles via the AssetRegistry ──
// spine, NOT call the raw world.instantiateScene (SharedRefReleasedError bug).
//
// Root cause recap: a defaultScene payload's MeshFilter.assetHandle is a GUID
// STRING (parseScenePayload). play-assemble originally did the raw
// world.instantiateScene(handle), which fed that string into the numeric
// shared-ref retain path → "SharedRefReleasedError: handle is already released".
// The fix routes through renderer.assets.instantiate (→ _resolveSceneGuids mints
// GUID→per-world numeric handle first). This test would have caught the bug: the
// prior fakes had assets:{} + a handle-free scene, so the resolve step was never
// exercised.
describe('▶ Play defaultScene instantiate routes through AssetRegistry (SharedRefReleasedError regression)', () => {
  it('calls renderer.assets.instantiate with the scene handle + play world, never the raw world.instantiateScene', async () => {
    const fakeRaf = installFakeRaf();
    try {
      const fr = makeFakeRenderer();
      const editorApp = makeFakeEditorApp();
      const gateway = makeFakeGateway();
      const boot = makeFakeBootstrap();

      // A play world that alloc's shared refs fine but EXPLODES if anyone calls
      // the raw instantiateScene directly — that's exactly the bypass the bug did.
      let rawInstantiateSceneCalls = 0;
      const makeGuardedWorld = () => {
        const real = new World() as unknown as {
          allocSharedRef(kind: string, payload: unknown): unknown;
          instantiateScene(...a: unknown[]): unknown;
          [k: string]: unknown;
        };
        return new Proxy(real, {
          get(target, prop, recv) {
            if (prop === 'instantiateScene') {
              return () => {
                rawInstantiateSceneCalls += 1;
                throw new Error('raw world.instantiateScene called directly — must go through AssetRegistry.instantiate');
              };
            }
            return Reflect.get(target, prop, recv);
          },
        });
      };

      const assemble = async () =>
        assemblePlayWorld({
          renderer: fr.renderer as never,
          loadDefaultScene: async () => makeSceneAssetWithHandle(),
          resolveBootstrap: async () => boot.entry as never,
          attachInput: () => undefined,
          newWorld: () => makeGuardedWorld() as never,
        });

      const lifecycle = createRunLifecycle({
        editorApp: editorApp as never,
        gateway: gateway as never,
        assemble: assemble as never,
      });

      // Must NOT throw (the bug threw SharedRefReleasedError here).
      await lifecycle.playSimulation();
      const playWorld = lifecycle.currentPlayWorld();
      expect(playWorld).not.toBeNull();

      // Routed through the registry spine exactly once, with the play world.
      expect(fr.instantiateCalls.length).toBe(1);
      expect(fr.instantiateCalls[0]?.world).toBe(playWorld);
      // The raw ECS instantiate was never called directly.
      expect(rawInstantiateSceneCalls).toBe(0);

      lifecycle.stopSimulation();
    } finally {
      fakeRaf.restore();
    }
  });
});

// ── Regression: ▶ Play must tick without a missing-resource fault ──────────────
// The assemble form of createApp does NOT auto-inject runtime-handle resources —
// only the plugins do. animationPlugin() (which play-assemble lists) registers
// advanceAnimationPlayer, whose system declares
// `resources: [ANIMATION_ASSET_RESOLVER_KEY]` UNCONDITIONALLY. When the engine
// canvas form inserted the resolver but the assemble form / plugin did not, the
// first play tick aborted with AppError[app-system-update-failed] "Required
// resource 'AnimationAssetResolver' not found" — and this suite's fake renderer
// onError no-op SWALLOWED it (115 pass, 0 fail, error only in console noise),
// the same blindspot that hid the SharedRefReleasedError above. This test taps
// the play WORLD's error handler (where ParamValidation routes the missing
// resource before the frame loop wraps it) and asserts a clean tick.
describe('▶ Play first tick has no missing-resource fault (AnimationAssetResolver regression)', () => {
  it('captures the play world error handler and steps a frame with zero errors', async () => {
    const fakeRaf = installFakeRaf();
    try {
      const fr = makeFakeRenderer();
      const editorApp = makeFakeEditorApp();
      const gateway = makeFakeGateway();
      const boot = makeFakeBootstrap();

      // A play world whose error handler is observable: the missing-resource
      // ParamValidation ('invalid') routes here BEFORE the frame loop wraps it
      // into app-system-update-failed (which the fake renderer.onError swallows).
      const worldErrors: unknown[] = [];
      const makeObservedWorld = () => {
        const w = new World() as unknown as { setErrorHandler(h: (e: unknown) => void): void };
        w.setErrorHandler((e) => worldErrors.push(e));
        return w;
      };

      const assemble = async () =>
        assemblePlayWorld({
          renderer: fr.renderer as never,
          loadDefaultScene: async () => makeSceneAsset(),
          resolveBootstrap: async () => boot.entry as never,
          attachInput: () => undefined,
          newWorld: () => makeObservedWorld() as never,
        });

      const lifecycle = createRunLifecycle({
        editorApp: editorApp as never,
        gateway: gateway as never,
        assemble: assemble as never,
      });

      await lifecycle.playSimulation();
      expect(lifecycle.currentPlayWorld()).not.toBeNull();

      // Drive frames — advanceAnimationPlayer runs each world.update(). If the
      // resolver resource were missing this pushes an Error (RED before the
      // engine animationPlugin self-owns the resolver).
      fakeRaf.step();
      fakeRaf.step();
      expect(worldErrors).toEqual([]);

      lifecycle.stopSimulation();
    } finally {
      fakeRaf.restore();
    }
  });
});

// ── AC-05 dead-concept sweep: run-lifecycle.ts must not carry epoch / 4-layer ──
// undo vocabulary anymore (grep -i epoch zero hits, plan-strategy AC-05).
describe('w6 — AC-05 dead-concept grep on run-lifecycle.ts source', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const runLifecycleSrc = readFileSync(resolve(here, '..', 'run-lifecycle.ts'), 'utf8');

  it('has zero "epoch" occurrences (case-insensitive)', () => {
    expect(/epoch/i.test(runLifecycleSrc)).toBe(false);
  });

  it('has no makeEpochGuard / EpochGuard export', () => {
    expect(runLifecycleSrc).not.toContain('EpochGuard');
    expect(runLifecycleSrc).not.toContain('makeEpochGuard');
  });

  it('has no 4-layer-undo machinery (rebindSceneInstance / despawnRuntimeSpawns / removeBootstrapSystems)', () => {
    expect(runLifecycleSrc).not.toContain('rebindSceneInstance');
    expect(runLifecycleSrc).not.toContain('despawnRuntimeSpawns');
    expect(runLifecycleSrc).not.toContain('removeBootstrapSystems');
  });
});

// The editor's OWN input backend (ViewportComponent createApp canvas form) must
// NEVER request pointer lock: two backends share the viewport canvas during
// ▶ Play, and pointer lock belongs solely to the game's play backend (which the
// game gates per view-mode via ctx.setPointerLockAllowed). The pre-#78 predicate
// `pointerLockAllowed: () => getInputTarget() === 'game'` made the editor backend
// lock the cursor during play·game regardless of the game's top-down/FPS choice
// — the root cause of the "top-down game locks + throws on next click" bug. This
// source-contract test pins the always-deny gate so a revert to the game-quadrant
// predicate is caught at unit time (the real createApp path needs a WebGPU canvas,
// so a source grep is the pragmatic guard).
describe('editor input backend never requests pointer lock (two-backend regression)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const viewportComponentSrc = readFileSync(resolve(here, '..', 'ViewportComponent.tsx'), 'utf8');

  it('createApp is given pointerLockAllowed: () => false', () => {
    expect(viewportComponentSrc).toContain('pointerLockAllowed: () => false');
  });

  it('does NOT gate the editor backend lock on getInputTarget() === \'game\' (the pre-#78 bug)', () => {
    // The predicate string may still appear inside the explanatory comment, so
    // assert it is not present as a live pointerLockAllowed binding.
    expect(viewportComponentSrc).not.toContain("pointerLockAllowed: () => getInputTarget() === 'game'");
  });
});

// ── uiRoot + registerCleanup (▶ Play controlled UI container / ■ Stop teardown) ──
// bun test has no DOM here (no jsdom/happy-dom), so the viewport container is a
// minimal fake element: it records createElement children + supports .remove(),
// enough to assert the #game-ui-root create-on-play / remove-on-stop lifecycle
// and the ctx.uiRoot / ctx.registerCleanup contract play-assemble now implements.

/** A fake DOM element tree standing in for the viewport panel container. Only the
 *  surface play-assemble touches: ownerDocument.createElement, appendChild, and a
 *  child .remove() that detaches from `children`. */
function makeFakeViewportContainer() {
  interface FakeEl {
    id: string;
    style: { cssText: string };
    parentNode: FakeEl | null;
    remove(): void;
  }
  const children: FakeEl[] = [];
  const container = {
    children,
    appendChild(el: FakeEl): FakeEl {
      children.push(el);
      el.parentNode = container as unknown as FakeEl;
      return el;
    },
    ownerDocument: {
      createElement(_tag: string): FakeEl {
        const el: FakeEl = {
          id: '',
          style: { cssText: '' },
          parentNode: null,
          remove(): void {
            const i = children.indexOf(el);
            if (i >= 0) children.splice(i, 1);
            el.parentNode = null;
          },
        };
        return el;
      },
    },
  };
  return container;
}

/** A bootstrap that captures the ctx it was handed so tests can assert uiRoot and
 *  drive registerCleanup. `onCtx` runs inside the entry (e.g. to register cleanups). */
function makeCtxCapturingBootstrap(onCtx?: (ctx: Record<string, unknown>) => void) {
  let captured: Record<string, unknown> | null = null;
  const entry = (_world: unknown, ctx?: unknown) => {
    captured = (ctx ?? {}) as Record<string, unknown>;
    onCtx?.(captured);
  };
  return {
    entry,
    get ctx() {
      return captured;
    },
  };
}

/** Lifecycle whose assemble threads a fake viewportContainer + ctx-capturing
 *  bootstrap, so uiRoot creation/removal + cleanup flush are observable. */
function buildUiRootLifecycle(onCtx?: (ctx: Record<string, unknown>) => void) {
  const fr = makeFakeRenderer();
  const editorApp = makeFakeEditorApp();
  const gateway = makeFakeGateway();
  const boot = makeCtxCapturingBootstrap(onCtx);
  const container = makeFakeViewportContainer();

  const assemble = async (): Promise<{ ok: true; value: PlayAssembly } | { ok: false; error: unknown }> =>
    assemblePlayWorld({
      renderer: fr.renderer as never,
      loadDefaultScene: async () => makeSceneAsset(),
      resolveBootstrap: async () => boot.entry as never,
      attachInput: () => undefined,
      newWorld: () => new World() as never,
      viewportContainer: container as never,
    });

  const lifecycle = createRunLifecycle({
    editorApp: editorApp as never,
    gateway: gateway as never,
    assemble: assemble as never,
  });

  return { lifecycle, container, boot };
}

describe('▶ Play uiRoot + registerCleanup (■ Stop teardown)', () => {
  it('creates #game-ui-root inside the viewport container on play, exposed as ctx.uiRoot', async () => {
    const fakeRaf = installFakeRaf();
    try {
      const t = buildUiRootLifecycle();
      await t.lifecycle.playSimulation();
      expect(t.container.children.length).toBe(1);
      const el = t.container.children[0]!;
      expect(el.id).toBe('game-ui-root');
      // The game received THAT element as ctx.uiRoot (the mount contract).
      expect(t.boot.ctx?.uiRoot).toBe(el);
      t.lifecycle.stopSimulation();
    } finally {
      fakeRaf.restore();
    }
  });

  it('removes #game-ui-root on stop (no UI remnant)', async () => {
    const fakeRaf = installFakeRaf();
    try {
      const t = buildUiRootLifecycle();
      await t.lifecycle.playSimulation();
      expect(t.container.children.length).toBe(1);
      t.lifecycle.stopSimulation();
      expect(t.container.children.length).toBe(0);
    } finally {
      fakeRaf.restore();
    }
  });

  it('flushes registerCleanup callbacks in REVERSE registration order on stop', async () => {
    const fakeRaf = installFakeRaf();
    try {
      const order: string[] = [];
      const t = buildUiRootLifecycle((ctx) => {
        const reg = ctx.registerCleanup as (fn: () => void) => void;
        reg(() => order.push('a'));
        reg(() => order.push('b'));
        reg(() => order.push('c'));
      });
      await t.lifecycle.playSimulation();
      expect(order).toEqual([]); // not flushed while playing
      t.lifecycle.stopSimulation();
      expect(order).toEqual(['c', 'b', 'a']); // LIFO
    } finally {
      fakeRaf.restore();
    }
  });

  it('a throwing cleanup does not strand later cleanups or block uiRoot removal', async () => {
    const fakeRaf = installFakeRaf();
    try {
      const order: string[] = [];
      const t = buildUiRootLifecycle((ctx) => {
        const reg = ctx.registerCleanup as (fn: () => void) => void;
        reg(() => order.push('first')); // registered first → flushed LAST
        reg(() => { throw new Error('boom'); }); // middle throws
        reg(() => order.push('last')); // registered last → flushed FIRST
      });
      await t.lifecycle.playSimulation();
      t.lifecycle.stopSimulation();
      // both non-throwing cleanups ran despite the middle throw...
      expect(order).toEqual(['last', 'first']);
      // ...and the container was still removed (removal is after the flush loop).
      expect(t.container.children.length).toBe(0);
    } finally {
      fakeRaf.restore();
    }
  });

  it('play->stop->play leaves zero leaked containers (per-run create+remove balance)', async () => {
    const fakeRaf = installFakeRaf();
    try {
      const t = buildUiRootLifecycle();
      await t.lifecycle.playSimulation();
      t.lifecycle.stopSimulation();
      await t.lifecycle.playSimulation();
      t.lifecycle.stopSimulation();
      expect(t.container.children.length).toBe(0);
    } finally {
      fakeRaf.restore();
    }
  });
});

// ── round-8 #3: play-attempt observability wiring ──────────────────────────────
// playSimulation() must mark the attempt in flight (beginPlayAttempt) up front,
// and on a DEGRADED assemble (ok:false) surface it through the front door
// (failPlayAttempt) instead of only console.warn — so a poller sees a terminal
// 'failed', not a mode flip that never comes (the round-3/5 trap). See
// gateway-play-phase-observability.test.ts for the gateway-side derive contract.
describe('▶ Play attempt observability (round-8 #3)', () => {
  it('a failed assemble fires beginPlayAttempt then failPlayAttempt, resumes edit, stays not-playing', async () => {
    const fakeRaf = installFakeRaf();
    try {
      const editorApp = makeFakeEditorApp();
      const gateway = makeFakeGateway();
      // assemble that always degrades (bad scene / createApp error path).
      const assemble = async () => ({ ok: false as const, error: { code: 'play-assemble-failed', hint: 'bad scene' } });
      let failed = 0;
      const lifecycle = createRunLifecycle({
        editorApp: editorApp as never,
        gateway: gateway as never,
        assemble: assemble as never,
        onPlayFailed: () => { failed++; },
      });

      await lifecycle.playSimulation();

      // The attempt was announced, then reported failed — in that order.
      const kinds = gateway.events.map((e) => e.kind);
      expect(kinds).toEqual(['beginPlayAttempt', 'failPlayAttempt']);
      // The error rode the front door (not just console.warn).
      const failEv = gateway.events.find((e) => e.kind === 'failPlayAttempt');
      expect(failEv?.error).toEqual({ code: 'play-assemble-failed', hint: 'bad scene' });
      // Never entered play; edit world was thawed (pause then resume).
      expect(kinds).not.toContain('enterPlay');
      expect(lifecycle.currentPlayWorld()).toBeNull();
      expect(editorApp.calls).toEqual(['pause', 'resume']);
      expect(failed).toBe(1);
    } finally {
      fakeRaf.restore();
    }
  });

  it('a successful assemble fires beginPlayAttempt then enterPlay (no failPlayAttempt)', async () => {
    const fakeRaf = installFakeRaf();
    try {
      const fr = makeFakeRenderer();
      const editorApp = makeFakeEditorApp();
      const gateway = makeFakeGateway();
      const boot = makeFakeBootstrap();
      let started = 0;
      const lifecycle = createRunLifecycle({
        editorApp: editorApp as never,
        gateway: gateway as never,
        assemble: async () => assemblePlayWorld({
          renderer: fr.renderer as never,
          loadDefaultScene: async () => makeSceneAsset(),
          resolveBootstrap: async () => boot.entry as never,
          attachInput: () => undefined,
          newWorld: () => new World() as never,
        }),
        onPlayStarted: () => { started++; },
      });
      await lifecycle.playSimulation();
      const kinds = gateway.events.map((e) => e.kind);
      expect(kinds[0]).toBe('beginPlayAttempt');
      expect(kinds).toContain('enterPlay');
      expect(kinds).not.toContain('failPlayAttempt');
      expect(started).toBe(1);
      lifecycle.stopSimulation();
    } finally {
      fakeRaf.restore();
    }
  });
});
