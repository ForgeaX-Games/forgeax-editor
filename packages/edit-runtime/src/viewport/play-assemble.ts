// play-assemble.ts — assemble a fresh play World for ▶ Play (level-load model).
//
// Proposition (P1 progressive disclosure): play = a fresh `new World()` assembled
// with the host's ONE renderer + the disk defaultScene, then bootstrapped — a
// second, independent level, not a mutation of the edit world. Details below.
//
// feat-20260707-editor-world-fork-ssot-level-load-play-activeworld M2.
//
// Two exports:
//   - shieldRendererDispose(renderer): the D-2 / R-N2 dispose-shield Proxy.
//   - assemblePlayWorld(deps): build { playApp, playWorld, detach } for the
//     run-lifecycle to drive.
//
// Why a fresh world (D-1 / requirements AC-04): play forks a brand-new engine
// World, assembles a playApp over it via the engine assemble form, loads the
// game's forge.json `defaultScene` GUID straight from disk (loadByGuid — a pure
// read path that sidesteps the collect-side serialization hazards, research
// Finding 2), instantiates it, and runs the game bootstrap. On ■ Stop the whole
// playWorld/playApp is dropped and GC'd (no restore concept). The edit world is
// never touched.
//
// Why the SINGLE renderer is reused (D-1): the editor owns exactly one host-owned
// renderer (WebGPU canvas context is unique). The engine frame loop's contract is
// `renderer.draw(world)` per-call (no cross-frame world binding), so the same
// renderer legitimately draws the edit world and the play world on two mutually
// exclusive frame loops. The renderer is passed into the assemble form by
// reference; its AssetRegistry (renderer.assets) is shared, so GPU assets / pack
// caches are loaded once, not duplicated.
//
// Why the dispose-shield (D-2 / R-N2): the engine `app.stop()` cleanup funnel
// calls `renderer.dispose()` UNCONDITIONALLY — even the assemble form, which
// claims the host owns backend lifecycle, still chains stop -> cleanupFunnel ->
// rendererDispose (create-app.ts:846-950; the audio backend is exempted there,
// the renderer is not — an assemble-contract asymmetry). If playApp.stop()
// disposed the shared renderer the edit viewport would go black. The shield wraps
// the renderer in a Proxy that turns `dispose` into a no-op while passing every
// other member through by reference, so playApp.stop() gets a clean teardown
// (rAF cancel + renderer.onError unsubscribe → playWorld fully unreferenced and
// GC-able, AC-05) WITHOUT killing the shared renderer.
//
// REMOVAL ANCHOR (R-N2): when the engine assemble form exempts the host-owned
// renderer from the stop-time dispose (symmetric with its existing audio-backend
// exemption), delete shieldRendererDispose + its call site here and pass the raw
// renderer straight through.
//
// AC-12 note: the `newWorld()` default below constructs `new World()` in editor
// source. This is a LEGAL play-world construction — lint-no-second-world scans the
// engine submodule diff only (research Finding 10 / plan-strategy D-6), so an
// editor-side play world is out of its scan domain by design.
//
// Anchors:
//   plan-strategy D-1 (single host-owned renderer, assemble form, draw(world) per-call)
//   plan-strategy D-2 (dual-App mutually-exclusive single driver + dispose-shield)
//   plan-strategy D-7 (assemble runs only user plugins → replicate the canvas default
//     5-plugin set + physicsPlugin)
//   plan-strategy D-8 (playWorld does NOT inject EditMode — same shape as game runtime)
//   requirements AC-04 (fresh new World → assemble → defaultScene loadByGuid →
//     registry.instantiate (GUID→handle resolve) → bootstrap)
//   research Finding 1 (AppAssembleArgs: renderer + world both host-provided) /
//     Finding 2 (GUID path is pure read, sidesteps fidelity hazards)
//   AGENTS.md anti-pattern #1 (no parallel re-implementation — engine parts all exist)

import { createApp, inputPlugin } from '@forgeax/engine-app';
import type { GameProjectionRegistrar } from '@forgeax/engine-app';
import {
  World,
  createQueryState,
  queryRun,
  Entity,
  type EntityHandle,
} from '@forgeax/engine-ecs';
import {
  transformPlugin,
  timePlugin,
  animationPlugin,
  Transform,
  Camera,
  perspective,
  PROPAGATE_TRANSFORMS_SYSTEM,
} from '@forgeax/engine-runtime';
import { statePlugin } from '@forgeax/engine-state';
import { physicsPlugin, Collider, CollidingEntities } from '@forgeax/engine-physics';
import { AUDIO_ENGINE_RESOURCE_KEY, AudioListener } from '@forgeax/engine-audio';
import {
  audioPlugin,
  createWebAudioBackend,
  WebAudioEngine,
  syncListenerFromWorldMatrix,
} from '@forgeax/engine-audio-webaudio';

// ── loose engine types (same `as never`/structural discipline as run-lifecycle /
// host-boot — the ECS/renderer types evolve independently) ────────────────────

/** Minimal renderer surface the assemble + shield need. `dispose` is the member
 *  the shield intercepts; the rest pass through. `assets` is the engine
 *  AssetRegistry — its `instantiate` spine is what resolves a scene payload's
 *  GUID-string handles → fresh per-world numeric handles before spawn. */
export interface ShieldableRenderer {
  dispose(): void;
  readonly assets: unknown;
  [k: string]: unknown;
}

/**
 * The AssetRegistry seam the play path uses to instantiate the defaultScene.
 * `instantiate(sceneHandle, world)` runs `_resolveSceneGuids` (GUID string →
 * per-world numeric handle mint via world.allocSharedRef) BEFORE
 * world.instantiateScene — the sanctioned engine spine every other editor
 * scene-load path uses (scene-persistence.ts loadSceneByGuid, host-boot preview
 * skin). Its Result `value` is the root EntityHandle directly (not `{ root }`).
 * Skipping it and calling the raw world.instantiateScene on a GUID-string
 * payload is what caused the SharedRefReleasedError on ▶ Play.
 */
interface SceneInstantiator {
  instantiate(
    sceneHandle: unknown,
    world: unknown,
    parent?: unknown,
  ): { ok: boolean; value?: unknown; error?: unknown };
}

/** The App handle assemblePlayWorld returns to the lifecycle (start/stop). */
export interface PlayApp {
  start(): { ok: boolean; error?: unknown };
  stop(): { ok: boolean; error?: unknown };
  /** Register a per-frame update on the play App's own frame loop (runs at play
   *  frame start, same contract as editorApp.registerUpdate). The run-lifecycle
   *  uses this to attach the DEV bridge eval-queue drain to the LIVE app while
   *  play has paused the edit app (otherwise a bridge eval submitted during play
   *  would queue forever — the drain is bound to editorApp.registerUpdate, which
   *  does not tick while paused). Dropped with the play App on ■ Stop (no leak). */
  registerUpdate(fn: (dt: number) => void): void;
}

/** What assemblePlayWorld hands back for the run-lifecycle to drive + drop. */
export interface PlayAssembly {
  /** The assembled play App (its own frame loop, started by the lifecycle). */
  readonly playApp: PlayApp;
  /** The fresh play World (drawn by the shared renderer while play is active). */
  readonly playWorld: unknown;
  /**
   * Install game-owned Play projections after Gateway points at this same live
   * world. Supplied by host-session; absent for ordinary/headless assembly.
   */
  readonly installGameProjection?: () => void;
  /** Clear game-owned Play projections before this world is torn down. */
  readonly clearGameProjection?: () => void;
  /** Tear down this play run's host-owned side effects. Called on ■ Stop AFTER
   *  playApp.stop() (run-lifecycle). Three things, in order:
   *   1. detach the play-side input backends (release the shared canvas), then
   *   2. flush the game's `ctx.registerCleanup` callbacks in REVERSE registration
   *      order (removeEventListener / AudioContext.close / clearTimeout …), then
   *   3. remove the `#game-ui-root` container whole (discards all game DOM/HUD).
   *  Guarded + idempotent: a second call is a no-op. No-op for the input/DOM arms
   *  when nothing was attached / no container was created (headless). */
  readonly detach: () => void;
}

type PhysicsBackend = 'rapier-3d' | 'rapier-2d';

/** Dependencies for one play assembly (Pipeline Isolation — every input explicit,
 *  so the headless test can substitute fakes for the disk/game/DOM seams). */
export interface AssemblePlayWorldDeps {
  /** The single host-owned renderer (shared across edit + play worlds, D-1). */
  readonly renderer: ShieldableRenderer;
  /**
   * Load the SceneAsset payload for the game's forge.json `defaultScene` GUID.
   * Production: forge.json read → AssetGuid.parse → renderer.assets.loadByGuid.
   * Returns null when the game has no defaultScene (graceful — play runs with an
   * empty scene, same as play-runtime's absent-defaultScene path).
   */
  readonly loadDefaultScene: () => Promise<unknown>;
  /**
   * Resolve + validate the game bootstrap entry (loadGame resolver). Returns null
   * when the game has no runnable module (graceful — play renders the scene with
   * no game logic).
   */
  readonly resolveBootstrap: () => Promise<((world: unknown, ctx?: unknown) => void | Promise<void>) | null>;
  /**
   * Attach the play-side input backend to the shared canvas + pre-inject the
   * INPUT_BACKEND_KEY resource BEFORE createApp runs plugins (engine D-3 pattern).
   * Returns a detach callback (or undefined for headless). Given the fresh world
   * so it can insertResource on it.
   */
  readonly attachInput: (world: unknown) => (() => void) | undefined;
  /** Optional physics backend (forge.json physics gate) — mirrors edit assembly. */
  readonly physics?: PhysicsBackend | undefined;
  /**
   * Optional editor-camera composite used by the live play App. The callback is
   * built only after the fresh play world exists, keeping its identity out of
   * editor-world state while allowing `play·scene` to render runtime entities
   * through the editor camera.
   */
  readonly createDrawSource?: (playWorld: unknown) => () => unknown | undefined;
  /** Construct the fresh play World. Default `() => new World()`. Injectable so
   *  the headless test can supply its own World ctor without a second import. */
  readonly newWorld?: () => unknown;
  /**
   * The viewport panel's DOM container (HostSessionContext.viewportContainer —
   * `.ep-viewport-root`, position:relative + overflow:hidden). ▶ Play creates a
   * fresh `<div id="game-ui-root">` child here and hands it to the game as
   * `ctx.uiRoot`; ■ Stop removes it whole (detach()), making a UI-remnant-after-
   * stop structurally impossible (the ECS-surgical undo can't reach DOM).
   * Optional: headless tests omit it (or inject a fake element) → `ctx.uiRoot` is
   * absent and games fall back to `document.body`.
   */
  readonly viewportContainer?: HTMLElement;
  /**
   * Optional host bridge for a game-owned action/read projection. The factory
   * creates one registry for this fresh Play world; bootstrap receives only its
   * registrar, while run-lifecycle controls install/clear around the live gateway.
   */
  readonly createGameProjection?: () => {
    readonly registrar: GameProjectionRegistrar;
    install(): void;
    clear(): void;
  };
}

/**
 * Wrap a renderer in a Proxy that turns `dispose` into a silent no-op and passes
 * every other member through by reference (D-2 / R-N2). See the file header for
 * why this exists and when it retires.
 */
export function shieldRendererDispose(renderer: ShieldableRenderer): ShieldableRenderer {
  return new Proxy(renderer, {
    get(target, prop, receiver) {
      if (prop === 'dispose') {
        // Silent no-op: playApp.stop() must not dispose the shared renderer.
        return () => {
          /* shielded — the host owns the renderer lifecycle (R-N2) */
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * Assemble a fresh play World + App (level-load, AC-04). See file header.
 *
 * Order: shield renderer → new World() → attachInput (pre-inject backend) →
 * createApp(assemble: shielded renderer + fresh world + explicit plugin set) →
 * loadDefaultScene → allocSharedRef → registry.instantiate (GUID→handle resolve
 * → spawn) → resolveBootstrap → bootstrap(world, ctx). Returns { playApp,
 * playWorld, detach }; the lifecycle
 * calls playApp.start() and, on ■ Stop, playApp.stop() + detach() then drops all
 * references.
 */
export async function assemblePlayWorld(
  deps: AssemblePlayWorldDeps,
): Promise<{ ok: true; value: PlayAssembly } | { ok: false; error: unknown }> {
  const shielded = shieldRendererDispose(deps.renderer);
  // AC-12: legal play-world construction (gate scans the engine submodule only).
  const playWorld = (deps.newWorld ?? (() => new World()))();

  // D-3 pattern: pre-inject the input backend BEFORE plugins run (inputPlugin's
  // build() guards on hasResource(INPUT_BACKEND_KEY) and is a no-op otherwise).
  const detachInput = deps.attachInput(playWorld);

  // Controlled UI root (game-context.ts BootstrapContext.uiRoot contract). A
  // fresh child <div id="game-ui-root"> of the viewport container, overlaying the
  // canvas without stealing input — children opt back in via pointer-events:auto
  // (installHud does exactly this). Removed whole on ■ Stop (detach() below), so a
  // game HUD can never survive a stop as a remnant. Absent viewportContainer
  // (headless) → uiRoot stays undefined and games fall back to document.body.
  // Use the container's ownerDocument (not the global `document`) so a fake
  // element supplied by the headless test drives creation + removal too.
  let uiRoot: HTMLElement | undefined;
  if (deps.viewportContainer) {
    uiRoot = deps.viewportContainer.ownerDocument.createElement('div');
    uiRoot.id = 'game-ui-root';
    uiRoot.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    deps.viewportContainer.appendChild(uiRoot);
  }

  // registerCleanup accumulator (game-context.ts BootstrapContext.registerCleanup
  // contract). Flushed in REVERSE registration order on ■ Stop (detach() below).
  const cleanups: Array<() => void> = [];

  // A game sees only this registrar while bootstrapping. The host keeps install /
  // clear control so the closures are never discoverable before Gateway points to
  // the same fresh Play world, and never survive that world's Stop teardown.
  const gameProjection = deps.createGameProjection?.();

  // Resolve the module BEFORE statePlugin() builds the fresh world. A game calls
  // defineState() at module scope, which populates the engine's token registry;
  // statePlugin reads that registry once to install State/NextState resources. If
  // the host imports main.ts after createApp, game-defined tokens exist but their
  // resources do not, and setNextState returns state-not-registered in Play.
  // This resolves only the module/export; bootstrap still runs after defaultScene
  // instantiation below, so the asset-first game contract remains unchanged.
  const entry = await deps.resolveBootstrap();

  // Audio backend (round-17, P8): the assemble form does NOT auto-create the
  // WebAudioBackend (createAppFromAssemble: "host owns backend lifecycle") — so
  // editor ▶ Play must pre-inject it itself, exactly as it pre-injects the input
  // backend above and as a standalone game's own createApp does (create-app.ts
  // canvas form :481). Without this the play world had no AUDIO_ENGINE_RESOURCE_KEY
  // and no audioTickSystem, so EVERY audio game's AudioSource silently never fired
  // in editor Play (Edit≠Play) — the same canvas-vs-assemble divergence class that
  // create-app.ts:455 already fixed for AnimationAssetResolver. audioPlugin.build()
  // is a no-op unless it finds this resource, so the inject MUST precede createApp.
  //
  // Cost for an audio-less scene is ~zero: createWebAudioBackend is fully lazy
  // (no AudioContext until the first play() / .listener touch — web-audio-engine.ts
  // D-3), the tick system walks zero AudioSource entities, and listener-sync only
  // touches backend.listener when an AudioListener entity exists. So we wire it
  // unconditionally (unlike physics, whose rapier WASM load is expensive and thus
  // forge.json-gated) — matching D-8 "the play world is the same shape as a
  // standalone game runtime."
  const audioBackend = createWebAudioBackend();
  (playWorld as { insertResource(key: unknown, value: unknown): void }).insertResource(
    AUDIO_ENGINE_RESOURCE_KEY,
    audioBackend,
  );

  // D-7: the assemble form runs ONLY the plugins we list (defaultSet=[]), so
  // explicitly replicate the canvas-form default 5 plugins + physics + audio
  // (aligning with the editor's own canvas-form assembly). D-8: no EditMode
  // resource is injected — the play world is the same shape as a standalone game
  // runtime, so game systems tick without a notEditing gate.
  const plugins: unknown[] = [
    transformPlugin(),
    timePlugin(),
    animationPlugin(),
    statePlugin(),
    inputPlugin(),
    audioPlugin(),
    ...(deps.physics ? [physicsPlugin(deps.physics)] : []),
  ];

  const appRes = await createApp({
    renderer: shielded as never,
    world: playWorld as never,
    plugins: plugins as never,
    ...(deps.createDrawSource ? { drawSource: deps.createDrawSource(playWorld) as never } : {}),
  });
  if (!appRes.ok) {
    detachInput?.();
    gameProjection?.clear();
    // createApp failed AFTER the container was appended — the only exit between
    // container creation and the success return. Remove it so ▶ Play's failure
    // path (run-lifecycle resumes edit) never leaks a #game-ui-root.
    uiRoot?.remove();
    return { ok: false, error: appRes.error };
  }
  const playApp = appRes.value as unknown as PlayApp & {
    registerUpdate(fn: (dt: number) => void): void;
    readonly renderer: unknown;
    readonly world: unknown;
    // M5 w23 / D-3: the assemble form exposes the host pre-injected input backend
    // (INPUT_BACKEND_KEY) verbatim as App.input, so the game-facing ctx setter
    // below can delegate the pointer-lock game gate to it.
    readonly input?: { setPointerLockAllowed?: (allowed: boolean) => void };
  };

  // Audio listener-sync (round-17, P8): the assemble form deliberately leaves
  // listener-sync to the host (create-app.ts:665 registers it ONLY on the canvas
  // form; assemble hosts "manage their own sync"). Mirror the canvas closure here
  // so spatial audio (spatialBlend>0) attenuates as the AudioListener entity moves.
  // Runs as an ECS addSystem after propagateTransforms (NOT registerUpdate) so it
  // reads the CURRENT frame's Transform.world mat4. backend.listener is a lazy
  // getter (builds the AudioContext on first touch) — read it ONLY when an
  // AudioListener entity actually exists so an audio-less / listener-less scene
  // never forces context creation.
  if (audioBackend instanceof WebAudioEngine) {
    const backend = audioBackend;
    (playWorld as {
      addSystem(sys: {
        name: string;
        after?: string[];
        queries: unknown[];
        fn: () => void;
      }): void;
    }).addSystem({
      name: 'audio-listener-sync',
      after: [PROPAGATE_TRANSFORMS_SYSTEM],
      queries: [],
      fn: () => {
        const query = createQueryState({ with: [AudioListener, Entity] });
        queryRun(query, playWorld as never, (bundle: { Entity: { self: ArrayLike<number> } }) => {
          const entitySelf = bundle.Entity.self;
          for (let i = 0; i < entitySelf.length; i++) {
            const entity = (entitySelf[i] ?? 0) as EntityHandle;
            const tf = (playWorld as { get(e: EntityHandle, c: unknown): { ok: boolean; value: { world: Float32Array } } }).get(entity, Transform);
            if (!tf.ok) continue;
            const listener = backend.listener;
            if (listener === undefined) break;
            syncListenerFromWorldMatrix(listener, tf.value.world);
            break;
          }
        });
      },
    });
  }

  // Sensor receiver-injection (round-20, P7): CollidingEntities is the physics
  // set-query receiver — the physics tick's writebackCollidingEntities
  // (rapier-physics-world-3d.ts) writes the overlap set ONLY into entities that
  // ALREADY carry CollidingEntities, and silently skips the rest. But the engine
  // declares CollidingEntities component-level `transient:true` (a derived runtime
  // view; persisting it would make instantiateScene double-write, AC-07/AC-08), so
  // it is stripped by collect-scene-asset on saveDocToDisk and never reaches the
  // disk-reloaded play world. A CODE game recovers by re-adding it at spawn in its
  // main.ts every session (collectathon spawnPlayer, physics D6); the editor's
  // author→save→Play flow has NO per-session code seam, so an authored sensor's
  // overlap set stayed empty forever in Play (Edit≠Play — the trigger never fires).
  //
  // Fix (same class as the audio-subsystem wiring above): derive receiver intent
  // from what the entity IS — a `Collider{isSensor:true}` whose entire purpose is
  // overlap detection — NOT from the stripped transient marker or a name list
  // (architecture §2.5: depend on the persisting `isSensor` signal, which DOES
  // round-trip, not a consumer-side enumeration). This system runs BEFORE the
  // physics backend sync each frame and adds an empty CollidingEntities to any
  // sensor lacking it, so the writeback has a target. Gated on deps.physics (no
  // physics backend → no writeback → nothing to receive). Targets are collected
  // first, then added AFTER the query completes (addComponent migrates archetypes,
  // which must not happen mid-iteration).
  if (deps.physics) {
    (playWorld as {
      addSystem(sys: {
        name: string;
        before?: string[];
        queries: unknown[];
        fn: () => void;
      }): void;
    }).addSystem({
      name: 'sensor-colliding-entities-receiver',
      before: ['physicsSyncBackend'],
      queries: [],
      fn: () => {
        const w = playWorld as {
          get(e: EntityHandle, c: unknown): { ok: boolean; value: { isSensor: boolean } };
          addComponent(e: EntityHandle, d: unknown): { ok: boolean };
        };
        const targets: EntityHandle[] = [];
        const query = createQueryState({ with: [Collider, Entity] });
        queryRun(query, playWorld as never, (bundle: { Entity: { self: ArrayLike<number> } }) => {
          const entitySelf = bundle.Entity.self;
          for (let i = 0; i < entitySelf.length; i++) {
            const entity = (entitySelf[i] ?? 0) as EntityHandle;
            const col = w.get(entity, Collider);
            if (!col.ok || col.value.isSensor !== true) continue;
            // already a receiver? skip (CollidingEntities.get is {ok:false} when absent)
            if (w.get(entity, CollidingEntities as never).ok) continue;
            targets.push(entity);
          }
        });
        for (const e of targets) {
          w.addComponent(e, { component: CollidingEntities, data: { entities: [] } });
        }
      },
    });
  }

  // ── Diagnostics reads (V11/C1): project play-world metrics through Gateway ──
  // Registers on the same gameProjection.registrar the game sees, so Gateway
  // listGameReads() / readGameState() discover them during Play. The reads are
  // server-owned (not game-owned) — they read the renderer + frame loop, not the
  // game world. The registrar is the same SSOT; the game sees these alongside its
  // own reads, which is correct (both project through the same door).
  if (gameProjection) {
    let frameCount = 0;
    let lastFps = 0;
    let lastDt = 0;
    playApp.registerUpdate((dt: number) => {
      frameCount++;
      lastDt = dt;
      if (frameCount % 60 === 0) {
        // Smoothed FPS over the last 60 frames (approximately 1s at 60fps).
        lastFps = Math.round(60 / Math.max(dt * 60, 0.001));
      }
    });

    gameProjection.registrar.registerRead({
      id: 'frameStats',
      title: 'Frame Statistics',
      description: 'Current FPS, frame time (dt), and frame count since Play started',
      read: () => ({
        fps: lastFps,
        dt: Math.round(lastDt * 1000) / 1000, // seconds → ms, rounded to µs
        frameCount,
      }),
    });

    gameProjection.registrar.registerRead({
      id: 'rendererStats',
      title: 'Renderer Statistics',
      description: 'EngineMetrics snapshot from the shared renderer',
      read: () => {
        const r = deps.renderer as { metrics?: { snapshot(): Record<string, number> } };
        return r.metrics?.snapshot() ?? {};
      },
    });
  }

  // ── defaultScene: pure-read GUID path (research Finding 2) ──
  // loadByGuid returned the SceneAsset payload — its handle-typed fields (e.g.
  // MeshFilter.assetHandle) hold GUID STRINGS (parseScenePayload resolves the
  // on-disk refs[] indices to GUIDs). Mint a scene handle on the play world, then
  // instantiate THROUGH the AssetRegistry spine (deps.renderer.assets.instantiate)
  // so _resolveSceneGuids mints those GUID strings → fresh per-world numeric
  // handles BEFORE world.instantiateScene spawns. Calling the raw
  // world.instantiateScene here (bypassing the registry) fed GUID strings into
  // the numeric shared-ref retain path → SharedRefReleasedError on ▶ Play.
  // Same spine as scene-persistence.ts loadSceneByGuid + host-boot preview skin.
  // Absent defaultScene → skip (graceful, AC-04).
  let defaultSceneRoot: unknown;
  let defaultScene: unknown;
  const sceneAsset = await deps.loadDefaultScene();
  if (sceneAsset !== null && sceneAsset !== undefined) {
    defaultScene = sceneAsset;
    const w = playWorld as { allocSharedRef(kind: string, payload: unknown): unknown };
    const handle = w.allocSharedRef('SceneAsset', sceneAsset);
    const reg = deps.renderer.assets as SceneInstantiator;
    // reg.instantiate's Result value is the root EntityHandle directly (not { root }).
    const instRes = reg.instantiate(handle, playWorld);
    if (instRes.ok) {
      defaultSceneRoot = instRes.value;
    } else {
      console.warn('[editor] ▶ Play defaultScene instantiate failed:', instRes.error);
    }
  }

  // ── bootstrap: run the game entry on the fresh world (same contract as
  // play-runtime — host instantiates defaultScene BEFORE entry runs). The module
  // was resolved before statePlugin() so module-level state tokens are registered;
  // invoke its bootstrap only now, after the default SceneAsset is instantiated. ──
  if (entry) {
    const rendererAssets = (deps.renderer as { assets?: unknown }).assets;
    const ctx = {
      world: playWorld,
      renderer: shielded,
      assets: rendererAssets,
      app: playApp,
      registerUpdate: (fn: (dt: number) => void) => playApp.registerUpdate(fn),
      setPointerLockAllowed: (allowed: boolean) => playApp.input?.setPointerLockAllowed?.(allowed),
      ...(uiRoot !== undefined ? { uiRoot } : {}),
      registerCleanup: (fn: () => void) => { cleanups.push(fn); },
      ...(gameProjection !== undefined ? { gameProjection: gameProjection.registrar } : {}),
      ...(defaultSceneRoot !== undefined ? { defaultSceneRoot } : {}),
      ...(defaultScene !== undefined ? { defaultScene } : {}),
    };
    await entry(playWorld, ctx as never);
  } else {
    console.warn('[editor] ▶ Play: no bootstrap entry resolved — game logic will not run');
  }

  // Fallback camera: if the play world has no Camera entity after bootstrap
  // (or bootstrap was skipped), spawn a default one so the renderer doesn't
  // fire render-system-no-camera every frame. Aligned with the play-runtime
  // preview fallback (play-runtime/src/main.ts). The fallback uses a safe
  // perspective projection; games that spawn their own camera are unaffected
  // (their camera takes precedence via the renderer's first-hit behavior).
  let hasCameraInPlayWorld = false;
  const cameraQuery = createQueryState({ with: [Camera, Entity] });
  queryRun(cameraQuery, playWorld as never, (bundle: { Entity: { self: ArrayLike<number> } }) => {
    if (bundle.Entity.self.length > 0) hasCameraInPlayWorld = true;
  });
  if (!hasCameraInPlayWorld) {
    console.warn('[editor] ▶ Play: no Camera entity in play world — spawning fallback camera');
    (playWorld as { spawn(...args: unknown[]): { unwrap(): number } }).spawn(
      { component: Transform, data: { pos: [0, 0.6, 5] } },
      { component: Camera, data: perspective({ fov: Math.PI / 3, aspect: 1, far: 1000 }) },
    );
  }

  const detach = (): void => {
    // Clear game-owned closures before any app/world teardown. This is idempotent
    // and prevents a stale Play callback from keeping the old world reachable.
    gameProjection?.clear();
    detachInput?.();
    // Audio backend teardown (round-17, P8): the assemble form does NOT wire
    // audioBackendDispose (create-app.ts: canvas form owns that; assemble hosts
    // own lifecycle, OOS-5), so ■ Stop must destroy the backend we created above —
    // stop all nodes, disconnect, close the AudioContext. Guarded + idempotent
    // (WebAudioEngine.destroy is a no-op if the context was never built). Runs
    // before the game cleanups so a game's registerCleanup(AudioContext) teardown
    // can't race a still-live backend node.
    try {
      audioBackend.destroy();
    } catch (err) {
      console.warn('[editor] ■ Stop audioBackend.destroy() threw:', err);
    }
    // Flush the game's cleanup callbacks in REVERSE registration order (LIFO).
    // pop() drains the array so a second detach() flushes nothing (idempotent);
    // each is guarded so one throwing cleanup can't strand the rest or block the
    // container removal below (mirrors run-lifecycle.ts's per-step try/catch).
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      try {
        fn();
      } catch (err) {
        console.warn('[editor] ■ Stop cleanup threw:', err);
      }
    }
    // Remove the controlled UI root whole — discards all game DOM/HUD. Guarded +
    // idempotent (null the ref so a second detach() is a no-op).
    if (uiRoot) {
      try {
        uiRoot.remove();
      } catch (err) {
        console.warn('[editor] ■ Stop uiRoot.remove() threw:', err);
      }
      uiRoot = undefined;
    }
  };

  return {
    ok: true,
    value: {
      playApp,
      playWorld,
      ...(gameProjection !== undefined
        ? { installGameProjection: gameProjection.install, clearGameProjection: gameProjection.clear }
        : {}),
      detach,
    },
  };
}
