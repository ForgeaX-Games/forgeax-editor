// run-lifecycle.ts — bootstrap-entry ▶ Play / ■ Stop for the edit world.
//
// feat-20260630-viewport-2x2-run-x-display-redesign M2 (w8/w9/w11/w12).
// plan-strategy D-1 / D-1a / D-1b / D-1c.
//
// WHY a separate module: main.tsx is a side-effectful entry (createApp, DOM,
// top-level await). It cannot be imported under `bun:test`. The run lifecycle —
// the epoch guard (D-1c) and playSimulation / stopSimulation (D-1 / D-1c) — is
// the part that needs deterministic unit + integration coverage (w8 / w9), so it
// lives here as a dependency-injected factory. main.tsx wires the real world /
// app / bus / engineSync into `createRunLifecycle` and exposes the returned
// play / stop to the ViewportBar. No engine code is touched — loadGame /
// BootstrapContext / world.removeSystem are all pre-existing engine surface.
//
// The ▶ Play model (D-1): on the EDIT world, call the game's bootstrap(world,ctx)
// — the same entry play-runtime drives (play-runtime/main.ts:357/413). The
// game's `world.addSystem` / `ctx.registerUpdate` inside bootstrap ARE the real
// system-registration points (research Finding 2). The old discoverModules path
// found zero systems for real games and never started them.
//
// The ■ Stop model (D-1c) — four undo layers, idempotent under repeated ▶/■:
//   1. named systems  — removeSystem the pre▶→post▶ diff (schedule.ts:342)  [w12]
//   2. registerUpdate — epoch guard: ■ bumps the epoch so last-gen callbacks
//                       short-circuit to no-op (frame-loop has no remove API)  [w12]
//   3. runtime spawns — despawn the pre▶→post-restore entity-handle diff       [w11]
//   4. doc pollution  — replaceDoc(snapshot) re-projects the pre▶ document     [w11]
//
// charter awareness: F1 (single lifecycle module, one epoch concept) +
// P3 (loadGame returns structured Result on every failure arm) + OOS-4 (zero
// editor semantics reach the engine — the engine sees world / entity ids only).

import type { EditSession } from '@forgeax/editor-core';
import { cloneEditSession, injectEditMode } from '@forgeax/editor-core';
import { loadGame, isLoadGameError } from '@forgeax/engine-app';

// Structural mirror of @forgeax/engine-app's BootstrapContext. The engine `.d.ts`
// module-shim degrades the exported interface to a namespace in this consumer's
// tsc program (TS2709 "Cannot use namespace as a type" — same shim gap as
// edit-mode.ts / open-project.ts), so ctx is built against this local shape and
// passed to the entry (whose param is `ctx?: BootstrapContext`) structurally.
interface RunBootstrapContext {
  readonly renderer?: unknown;
  readonly assets: unknown;
  readonly app: unknown;
  readonly registerUpdate: (fn: (dt: number) => void) => void;
  readonly defaultSceneRoot?: number;
  readonly defaultScene?: unknown;
}

// ────────────────────────────────────────────────────────────────────────────
// D-1c layer 2 — run-generation epoch guard (pure)
// ────────────────────────────────────────────────────────────────────────────

/**
 * A run-generation guard. `wrap(fn)` captures the CURRENT epoch and returns a
 * callback that only forwards to `fn` while the epoch is unchanged; `bump()`
 * advances the epoch so every callback wrapped in a prior generation becomes a
 * silent no-op.
 *
 * This is the D-1c layer-2 undo channel for `ctx.registerUpdate`: the engine
 * frame loop has `addUpdateCallback` but no remove counterpart
 * (frame-loop.ts). Rather than grow the engine surface with a remove API for an
 * editor lifecycle need (OOS-4), ■ Stop bumps the epoch and the accumulated
 * callbacks from the stopped run go dormant in place.
 *
 * Pure: depends only on its own closed-over counter — no world, no frame loop.
 */
export interface EpochGuard {
  /** Wrap a per-frame callback so it only runs while its capture-time epoch is current. */
  wrap(fn: (dt: number) => void): (dt: number) => void;
  /** Advance the generation; all previously wrapped callbacks go no-op. */
  bump(): void;
  /** Current generation counter (for assertions / diagnostics). */
  current(): number;
}

/** Construct an {@link EpochGuard}. Starts at generation 0. */
export function makeEpochGuard(): EpochGuard {
  let epoch = 0;
  return {
    wrap(fn: (dt: number) => void): (dt: number) => void {
      const my = epoch;
      return (dt: number) => {
        if (my === epoch) fn(dt);
      };
    },
    bump(): void {
      epoch += 1;
    },
    current(): number {
      return epoch;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Dependency-injected run lifecycle
// ────────────────────────────────────────────────────────────────────────────

/** Minimal world surface the lifecycle needs (engine ECS World, structurally). */
export interface RunWorld {
  inspect(): { readonly systems: ReadonlyArray<{ readonly name: string }> };
  removeSystem(name: string): { ok: boolean; error?: unknown };
  despawn(handle: never): unknown;
}

/** Minimal bus surface (EditorBus, structurally). */
export interface RunBus {
  readonly doc: EditSession;
  replaceDoc(doc: EditSession): void;
}

/**
 * Everything `createRunLifecycle` needs, declared explicitly (Pipeline
 * Isolation): no implicit globals, so the integration test (w9) can supply a
 * headless createApp world + a fake bus and drive the whole ▶/■ roundtrip.
 */
export interface RunLifecycleDeps {
  /** The edit world (shared by editor + game — single-world model, C-1). */
  readonly world: RunWorld;
  /** The App handle; `registerUpdate` feeds the live edit frame loop (D-1b). */
  readonly app: { registerUpdate(fn: (dt: number) => void): void };
  /** The renderer (BootstrapContext.renderer + .assets source). */
  readonly renderer: { readonly assets: unknown };
  /** The editor bus carrying the authored document (snapshot / restore). */
  readonly bus: RunBus;
  /** Collect every live entity handle in the world (pre▶ / post-restore diff). */
  readonly collectEntityHandles: () => Set<number>;
  /** Resolve + validate the active game's bootstrap entry (loadGame resolver). */
  readonly resolveGameModule: () => Promise<unknown>;
  /** Active game slug (for loadGame error detail / logging). */
  readonly getSlug: () => string;
  /** Doc-projected default-scene root carrying SceneInstance (D-1a). */
  readonly getDefaultSceneRoot: () => number | undefined;
  /** SceneAsset payload derived from the doc projection (D-1a). */
  readonly getDefaultScene: () => unknown;
  /**
   * Called after a successful bootstrap so the host can pick up any camera the
   * game spawned directly on the world (not through the doc) and re-derive the
   * active camera (AC-12 hard cut). Optional — omitted in headless tests.
   */
  readonly onAfterBootstrap?: () => void;
}

/** The ▶/■ pair plus the epoch guard so callers can assert on it (tests). */
export interface RunLifecycle {
  playSimulation(): Promise<void>;
  stopSimulation(): void;
  readonly epoch: EpochGuard;
}

/**
 * Build the ▶ Play / ■ Stop pair for one edit world.
 *
 * playSimulation (D-1 / D-1a / D-1b / D-1c):
 *   snapshot the doc, record the pre▶ system-name + entity-handle baselines,
 *   loadGame(slug, resolver) to validate `module.bootstrap`, assemble the
 *   BootstrapContext (renderer / assets / app / epoch-gated registerUpdate /
 *   doc-projected defaultSceneRoot + defaultScene), `await entry(world, ctx)`
 *   so the game registers its systems/callbacks, then injectEditMode(false) to
 *   open the notEditing gate and let them tick on the already-running edit frame
 *   loop.
 *
 * stopSimulation (D-1c): see the per-line notes — w11 lands layers 3+4
 * (doc restore + runtime entity despawn); w12 lands layers 1+2 (removeSystem
 * diff + epoch bump). Idempotent under repeated ▶/■.
 */
export function createRunLifecycle(deps: RunLifecycleDeps): RunLifecycle {
  const epoch = makeEpochGuard();
  let snapshot: EditSession | null = null;
  let prePlaySystems: Set<string> | null = null;
  let prePlayEntities: Set<number> | null = null;

  async function playSimulation(): Promise<void> {
    // D-3 snapshot-once: deep-copy the doc before any play mutation touches it.
    snapshot = cloneEditSession(deps.bus.doc);
    // D-1c layer-1 / layer-3 baselines: system names + entity handles at ▶.
    prePlaySystems = new Set(deps.world.inspect().systems.map((s) => s.name));
    prePlayEntities = deps.collectEntityHandles();

    // D-1: resolve + validate the game entry (same contract as play-runtime).
    const slug = deps.getSlug();
    const result = await loadGame(slug, async () => deps.resolveGameModule());
    if (!result.ok) {
      if (isLoadGameError(result.error)) {
        console.warn(
          `[editor] ▶ Play loadGame: ${result.error.code} — ${result.error.expected} (${result.error.hint})`,
        );
      } else {
        console.warn('[editor] ▶ Play loadGame failed:', result.error);
      }
      // Graceful degradation (charter P3 / §9): the scene stays rendered in the
      // edit world; the run just has no game logic. Open the gate anyway so any
      // doc-projected systems tick, staying consistent with a started run.
      injectEditMode(deps.world as never, false);
      return;
    }
    const entry = result.value;

    // D-1a: assemble the BootstrapContext from edit-world originals. The
    // registerUpdate is epoch-gated (D-1c layer-2). defaultSceneRoot /
    // defaultScene come from the doc projection, NOT a forge.json GUID re-
    // instantiate (would duplicate the entities EngineSync already projected).
    const defaultSceneRoot = deps.getDefaultSceneRoot();
    const defaultScene = deps.getDefaultScene();
    const ctx: RunBootstrapContext = {
      renderer: deps.renderer,
      assets: deps.renderer.assets,
      app: deps.app,
      registerUpdate: (fn: (dt: number) => void) => {
        deps.app.registerUpdate(epoch.wrap(fn));
      },
      ...(defaultSceneRoot !== undefined ? { defaultSceneRoot } : {}),
      ...(defaultScene !== undefined ? { defaultScene } : {}),
    };

    // D-1: bootstrap registers systems/callbacks on the live edit world.
    await entry(deps.world as never, ctx as never);

    // D-1b: release the notEditing gate so the freshly registered game systems
    // tick on the edit frame loop that is already running (no new loop).
    injectEditMode(deps.world as never, false);

    // AC-12: pick up any camera the game spawned + hard-cut the active camera.
    deps.onAfterBootstrap?.();
  }

  function stopSimulation(): void {
    // D-1c layer-0: freeze game systems (notEditing gate closes).
    injectEditMode(deps.world as never, true);

    // D-1c layer-2: bump the run epoch so every registerUpdate callback from
    // this run short-circuits to no-op on its next frame (no accumulation over
    // repeated ▶/■ — the frame loop has no removeUpdateCallback).
    epoch.bump();

    // D-1c layer-1: removeSystem the systems bootstrap added, computed as the
    // pre▶ → now diff of world.inspect().systems. A second ■ with no ▶ finds an
    // empty diff (prePlaySystems already covers the surviving names) — idempotent.
    if (prePlaySystems) {
      for (const s of deps.world.inspect().systems) {
        if (!prePlaySystems.has(s.name)) {
          const r = deps.world.removeSystem(s.name);
          if (!r.ok) {
            console.warn(`[editor] ■ Stop removeSystem("${s.name}") failed:`, r.error);
          }
        }
      }
    }

    // D-3 / D-1c layer-4 + layer-3: restore the doc, then despawn runtime spawns.
    if (snapshot) {
      deps.bus.replaceDoc(snapshot);
      if (prePlayEntities) {
        for (const h of deps.collectEntityHandles()) {
          if (!prePlayEntities.has(h)) {
            try {
              deps.world.despawn(h as never);
            } catch {
              /* entity already gone — idempotent */
            }
          }
        }
      }
    }
    snapshot = null;
    prePlaySystems = null;
    prePlayEntities = null;
  }

  return { playSimulation, stopSimulation, epoch };
}
