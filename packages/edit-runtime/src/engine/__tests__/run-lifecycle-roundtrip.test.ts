// run-lifecycle-roundtrip.test.ts (w9) — bootstrap ▶/■ roundtrip integration.
//
// Drives createRunLifecycle over a REAL engine ECS World with a fake game
// module whose bootstrap registers a named system (world.addSystem) AND a
// per-frame callback (ctx.registerUpdate). Asserts the full D-1 / D-1c contract:
//
//   (1) playSimulation -> bootstrap ran, its named system is in
//       world.inspect().systems, EditMode.active === false (gate open).
//   (2) stopSimulation -> EditMode.active === true, the bootstrap system is
//       removed (removeSystem diff clean), bus.replaceDoc(snapshot) fired.
//   (3) repeat ▶/■ twice -> system count after the 2nd stop equals after the
//       1st (idempotent — no system accumulation).
//   (4) repeat ▶/■ twice -> registerUpdate callbacks from the 1st run are
//       silenced by the epoch guard after the 1st stop, and only the current
//       run's callback fires (no callback accumulation).
//
// Anchors:
//   plan-strategy D-1 (▶ Play calls bootstrap(world, ctx) on the edit world)
//   plan-strategy D-1c (four-layer idempotent undo: systems / callbacks /
//     entities / doc)
//   requirements AC-06 (■ restores authored state)
//   requirements AC-08 / AC-09 (continuous run; repeated ▶/■ accumulates nothing)

import { beforeEach, describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { createRunLifecycle, type RunLifecycle } from '../run-lifecycle';

// `World` is imported as a VALUE and used through `InstanceType<typeof World>` to
// dodge the engine `.d.ts` module-shim TS2709 ("Cannot use namespace 'World' as
// a type") — same idiom as edit-mode.ts / systems-panel.tsx in this package.
type EcsWorld = InstanceType<typeof World>;

// ── Fakes ────────────────────────────────────────────────────────────────────

type EditModeState = { active: boolean };

/** Read the EditMode resource injected by injectEditMode. */
function editModeActive(world: EcsWorld): boolean | undefined {
  const w = world as unknown as {
    hasResource(k: string): boolean;
    getResource<T>(k: string): T;
  };
  if (!w.hasResource('EditMode')) return undefined;
  return w.getResource<EditModeState>('EditMode').active;
}

/** Minimal fake bus: a doc object + replaceDoc recorder. */
function makeFakeBus() {
  const doc = { entities: {}, order: [] as number[] } as unknown as never;
  const replaceDocCalls: unknown[] = [];
  return {
    doc,
    replaceDoc(next: unknown) {
      replaceDocCalls.push(next);
    },
    replaceDocCalls,
  };
}

/**
 * A fake game module. Each bootstrap call registers a UNIQUELY named system so
 * we can watch removeSystem clean it up, plus a per-frame callback that
 * increments a shared tick counter through ctx.registerUpdate (epoch-gated).
 */
function makeFakeGame() {
  let bootstrapCount = 0;
  const frameCallbacks: Array<(dt: number) => void> = [];
  let tickCount = 0;
  const module = {
    async bootstrap(world: EcsWorld, ctx?: { registerUpdate: (fn: (dt: number) => void) => void }) {
      bootstrapCount += 1;
      world.addSystem({
        name: `fake-game-system-${bootstrapCount}`,
        queries: [],
        fn: () => {},
      });
      ctx?.registerUpdate(() => {
        tickCount += 1;
      });
    },
  };
  return {
    module,
    frameCallbacks,
    get bootstrapCount() {
      return bootstrapCount;
    },
    get tickCount() {
      return tickCount;
    },
    /** Simulate one frame: fire every registered (epoch-wrapped) callback. */
    tickFrame() {
      for (const cb of frameCallbacks) cb(0.016);
    },
  };
}

function buildLifecycle(): {
  world: EcsWorld;
  lifecycle: RunLifecycle;
  game: ReturnType<typeof makeFakeGame>;
  bus: ReturnType<typeof makeFakeBus>;
  frameCallbacks: Array<(dt: number) => void>;
} {
  const world = new World();
  const bus = makeFakeBus();
  const game = makeFakeGame();
  // The app.registerUpdate stand-in appends to a shared callback list that
  // tickFrame() drains — models the engine frame loop's updateCallbacks.
  const frameCallbacks = game.frameCallbacks;
  const lifecycle = createRunLifecycle({
    world: world as never,
    app: {
      registerUpdate(fn: (dt: number) => void) {
        frameCallbacks.push(fn);
      },
    },
    renderer: { assets: {} },
    bus: bus as never,
    collectEntityHandles: () => new Set<number>(),
    resolveGameModule: async () => game.module,
    getSlug: () => 'fake-game',
    getDefaultSceneRoot: () => undefined,
    getDefaultScene: () => undefined,
  });
  return { world, lifecycle, game, bus, frameCallbacks };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('w9 — bootstrap ▶/■ roundtrip', () => {
  let ctx: ReturnType<typeof buildLifecycle>;
  beforeEach(() => {
    ctx = buildLifecycle();
  });

  it('(1) playSimulation runs bootstrap, registers system, opens the gate', async () => {
    await ctx.lifecycle.playSimulation();
    expect(ctx.game.bootstrapCount).toBe(1);
    const names = ctx.world.inspect().systems.map((s: { name: string }) => s.name);
    expect(names).toContain('fake-game-system-1');
    expect(editModeActive(ctx.world)).toBe(false);
  });

  it('(2) stopSimulation closes the gate, removes the system, restores the doc', async () => {
    await ctx.lifecycle.playSimulation();
    ctx.lifecycle.stopSimulation();
    expect(editModeActive(ctx.world)).toBe(true);
    const names = ctx.world.inspect().systems.map((s: { name: string }) => s.name);
    expect(names).not.toContain('fake-game-system-1');
    expect(ctx.bus.replaceDocCalls.length).toBe(1);
  });

  it('(3) repeated ▶/■ does not accumulate systems (idempotent)', async () => {
    await ctx.lifecycle.playSimulation();
    ctx.lifecycle.stopSimulation();
    const afterFirstStop = ctx.world.inspect().systems.length;

    await ctx.lifecycle.playSimulation();
    ctx.lifecycle.stopSimulation();
    const afterSecondStop = ctx.world.inspect().systems.length;

    expect(afterSecondStop).toBe(afterFirstStop);
  });

  it('(4) repeated ▶/■ does not accumulate live callbacks (epoch guard)', async () => {
    // First run: register + tick a few frames.
    await ctx.lifecycle.playSimulation();
    ctx.game.tickFrame();
    ctx.game.tickFrame();
    const afterFirstRun = ctx.game.tickCount;
    expect(afterFirstRun).toBe(2);

    // Stop: the epoch bump silences the first run's callback.
    ctx.lifecycle.stopSimulation();
    ctx.game.tickFrame(); // fires BOTH registered callbacks, but gen-1 is dead
    expect(ctx.game.tickCount).toBe(afterFirstRun); // no increment — old cb silenced

    // Second run: a NEW callback registers; ticking now advances by 1 per frame,
    // proving the first run's callback stays dormant (no accumulation).
    await ctx.lifecycle.playSimulation();
    const before = ctx.game.tickCount;
    ctx.game.tickFrame();
    expect(ctx.game.tickCount).toBe(before + 1); // only the current run's cb runs
  });
});
