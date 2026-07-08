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
//     instantiateScene → bootstrap)
//   research Finding 1 (AppAssembleArgs: renderer + world both host-provided) /
//     Finding 2 (GUID path is pure read, sidesteps fidelity hazards)
//   AGENTS.md anti-pattern #1 (no parallel re-implementation — engine parts all exist)

import { createApp, inputPlugin } from '@forgeax/engine-app';
import { World } from '@forgeax/engine-ecs';
import { transformPlugin, timePlugin, animationPlugin } from '@forgeax/engine-runtime';
import { statePlugin } from '@forgeax/engine-state';
import { physicsPlugin } from '@forgeax/engine-physics';

// ── loose engine types (same `as never`/structural discipline as run-lifecycle /
// host-boot — the ECS/renderer types evolve independently) ────────────────────

/** Minimal renderer surface the assemble + shield need. `dispose` is the member
 *  the shield intercepts; the rest pass through. */
export interface ShieldableRenderer {
  dispose(): void;
  readonly assets: unknown;
  [k: string]: unknown;
}

/** The App handle assemblePlayWorld returns to the lifecycle (start/stop). */
export interface PlayApp {
  start(): { ok: boolean; error?: unknown };
  stop(): { ok: boolean; error?: unknown };
}

/** What assemblePlayWorld hands back for the run-lifecycle to drive + drop. */
export interface PlayAssembly {
  /** The assembled play App (its own frame loop, started by the lifecycle). */
  readonly playApp: PlayApp;
  /** The fresh play World (drawn by the shared renderer while play is active). */
  readonly playWorld: unknown;
  /** Detach the play-side backends the host attached (input listeners etc.).
   *  Called on ■ Stop AFTER playApp.stop() so the shared canvas is released back
   *  to the edit session. No-op when nothing was attached (headless). */
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
  /** Construct the fresh play World. Default `() => new World()`. Injectable so
   *  the headless test can supply its own World ctor without a second import. */
  readonly newWorld?: () => unknown;
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
 * loadDefaultScene → allocSharedRef → instantiateScene → resolveBootstrap →
 * bootstrap(world, ctx). Returns { playApp, playWorld, detach }; the lifecycle
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

  // D-7: the assemble form runs ONLY the plugins we list (defaultSet=[]), so
  // explicitly replicate the canvas-form default 5 plugins + physics (aligning
  // with the editor's own canvas-form assembly). D-8: no EditMode resource is
  // injected — the play world is the same shape as a standalone game runtime, so
  // game systems tick without a notEditing gate.
  const plugins: unknown[] = [
    transformPlugin(),
    timePlugin(),
    animationPlugin(),
    statePlugin(),
    inputPlugin(),
    ...(deps.physics ? [physicsPlugin(deps.physics)] : []),
  ];

  const appRes = await createApp({
    renderer: shielded as never,
    world: playWorld as never,
    plugins: plugins as never,
  });
  if (!appRes.ok) {
    detachInput?.();
    return { ok: false, error: appRes.error };
  }
  const playApp = appRes.value as unknown as PlayApp & {
    registerUpdate(fn: (dt: number) => void): void;
    readonly renderer: unknown;
    readonly world: unknown;
  };

  // ── defaultScene: pure-read GUID path (research Finding 2) ──
  // loadByGuid returned the SceneAsset payload; mint a shared handle on the play
  // world and instantiate. Absent defaultScene → skip (graceful, AC-04).
  let defaultSceneRoot: unknown;
  let defaultScene: unknown;
  const sceneAsset = await deps.loadDefaultScene();
  if (sceneAsset !== null && sceneAsset !== undefined) {
    defaultScene = sceneAsset;
    const w = playWorld as {
      allocSharedRef(kind: string, payload: unknown): unknown;
      instantiateScene(handle: unknown): { ok: boolean; value?: { root: unknown }; error?: unknown };
    };
    const handle = w.allocSharedRef('SceneAsset', sceneAsset);
    const instRes = w.instantiateScene(handle);
    if (instRes.ok) {
      defaultSceneRoot = instRes.value?.root;
    } else {
      console.warn('[editor] ▶ Play defaultScene instantiate failed:', (instRes as { error?: unknown }).error);
    }
  }

  // ── bootstrap: run the game entry on the fresh world (same contract as
  // play-runtime — host instantiates defaultScene BEFORE entry runs). ──
  const entry = await deps.resolveBootstrap();
  if (entry) {
    const rendererAssets = (deps.renderer as { assets?: unknown }).assets;
    const ctx = {
      world: playWorld,
      renderer: shielded,
      assets: rendererAssets,
      app: playApp,
      registerUpdate: (fn: (dt: number) => void) => playApp.registerUpdate(fn),
      ...(defaultSceneRoot !== undefined ? { defaultSceneRoot } : {}),
      ...(defaultScene !== undefined ? { defaultScene } : {}),
    };
    await entry(playWorld, ctx as never);
  }

  const detach = (): void => {
    detachInput?.();
  };

  return { ok: true, value: { playApp, playWorld, detach } };
}
