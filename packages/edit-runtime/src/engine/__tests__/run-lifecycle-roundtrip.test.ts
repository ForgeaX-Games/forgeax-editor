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
  let lastCtx: { world?: unknown; registerUpdate: (fn: (dt: number) => void) => void } | undefined;
  const module = {
    async bootstrap(
      world: EcsWorld,
      ctx?: { world?: unknown; registerUpdate: (fn: (dt: number) => void) => void },
    ) {
      bootstrapCount += 1;
      lastCtx = ctx;
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
    /** The ctx object the last bootstrap call received (contract regression). */
    get lastCtx() {
      return lastCtx;
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

  it('(1b) bootstrap ctx carries world (play-runtime GameContext parity)', async () => {
    // Games type Ctx = Parameters<GameEntry>[0] (= GameContext) and read
    // ctx.world (e.g. cow-survivor EnemyManager -> world.allocSharedRef).
    // play-runtime puts world on the ctx; edit-runtime must match or those
    // games crash "Cannot read properties of undefined (reading 'allocSharedRef')".
    await ctx.lifecycle.playSimulation();
    expect(ctx.game.lastCtx?.world).toBe(ctx.world);
  });

  it('(2) stopSimulation closes the gate + removes the system', async () => {
    await ctx.lifecycle.playSimulation();
    ctx.lifecycle.stopSimulation();
    expect(editModeActive(ctx.world)).toBe(true);
    const names = ctx.world.inspect().systems.map((s: { name: string }) => s.name);
    expect(names).not.toContain('fake-game-system-1');
    // M4 / AC-10: doc restore is NOT replaceDoc(cloneEditSession) anymore — Stop
    // despawns + re-instantiates the SceneAsset (engine-native). With no default
    // scene root (getDefaultSceneRoot → undefined here), that branch is skipped,
    // so no re-instantiate and no rebind fire; the scene-restore + rebind
    // contract is covered by the dedicated test below.
    expect(ctx.bus.replaceDocCalls.length).toBe(0);
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

// ── B (controlled UI root) + A (cleanup hook) ──────────────────────────────────
//
// The disposable-boundary layers that reach beyond the ECS world — the root
// cause of UI-remnant-after-stop. A fake game mounts a DOM node into ctx.uiRoot
// and registers a cleanup via ctx.registerCleanup; we assert ▶ builds the root
// and hands it + registerCleanup to the game, and ■ unmounts the root and flushes
// the cleanups (reverse order), idempotent under repeated ▶/■.

/** A fake game that exercises the uiRoot + registerCleanup ctx surface. */
function makeUiFakeGame() {
  const cleanupOrder: number[] = [];
  let seenUiRoot: HTMLElement | undefined;
  const module = {
    async bootstrap(
      _world: EcsWorld,
      ctx?: {
        registerUpdate: (fn: (dt: number) => void) => void;
        uiRoot?: HTMLElement;
        registerCleanup?: (fn: () => void) => void;
      },
    ) {
      seenUiRoot = ctx?.uiRoot;
      // Mount a child into the controlled root (models a HUD append).
      if (ctx?.uiRoot) ctx.uiRoot.appendChild({ tag: 'hud' } as unknown as Node);
      // Register two cleanups so we can assert reverse-order flush.
      ctx?.registerCleanup?.(() => cleanupOrder.push(1));
      ctx?.registerCleanup?.(() => cleanupOrder.push(2));
    },
  };
  return {
    module,
    cleanupOrder,
    get seenUiRoot() {
      return seenUiRoot;
    },
  };
}

/** A fake DOM element recording appendChild / remove for assertions. */
function makeFakeUiRoot() {
  const children: unknown[] = [];
  let removed = false;
  const el = {
    appendChild(c: unknown) {
      children.push(c);
      return c;
    },
    remove() {
      removed = true;
    },
  };
  return {
    el: el as unknown as HTMLElement,
    get childCount() {
      return children.length;
    },
    get removed() {
      return removed;
    },
  };
}

describe('B/A — controlled UI root + cleanup hook', () => {
  function buildUi() {
    const world = new World();
    const bus = makeFakeBus();
    const game = makeUiFakeGame();
    const frameCallbacks: Array<(dt: number) => void> = [];
    // A fresh fake root per mount call (models the host building #game-ui-root).
    const mounted: ReturnType<typeof makeFakeUiRoot>[] = [];
    let unmountCount = 0;
    const lifecycle = createRunLifecycle({
      world: world as never,
      app: { registerUpdate: (fn) => { frameCallbacks.push(fn); } },
      renderer: { assets: {} },
      bus: bus as never,
      collectEntityHandles: () => new Set<number>(),
      resolveGameModule: async () => game.module,
      getSlug: () => 'ui-fake-game',
      getDefaultSceneRoot: () => undefined,
      getDefaultScene: () => undefined,
      mountUiRoot: () => {
        const r = makeFakeUiRoot();
        mounted.push(r);
        return r.el;
      },
      unmountUiRoot: (el: HTMLElement) => {
        unmountCount += 1;
        (el as unknown as { remove(): void }).remove();
      },
    });
    return { lifecycle, game, mounted, get unmountCount() { return unmountCount; } };
  }

  it('▶ builds the UI root and hands it + registerCleanup to the game', async () => {
    const t = buildUi();
    await t.lifecycle.playSimulation();
    expect(t.mounted.length).toBe(1);
    // The game received the same element the host mounted, and mounted into it.
    expect(t.game.seenUiRoot).toBe(t.mounted[0]!.el);
    expect(t.mounted[0]!.childCount).toBe(1);
  });

  it('■ unmounts the root whole and flushes cleanups in reverse order', async () => {
    const t = buildUi();
    await t.lifecycle.playSimulation();
    t.lifecycle.stopSimulation();
    expect(t.unmountCount).toBe(1);
    expect(t.mounted[0]!.removed).toBe(true);
    // Reverse registration order: [2, 1] (unwind semantics).
    expect(t.game.cleanupOrder).toEqual([2, 1]);
  });

  it('repeated ▶/■ is idempotent — a second ■ with no ▶ is a no-op', async () => {
    const t = buildUi();
    await t.lifecycle.playSimulation();
    t.lifecycle.stopSimulation();
    // A stray second stop must not re-unmount or re-flush.
    t.lifecycle.stopSimulation();
    expect(t.unmountCount).toBe(1);
    expect(t.game.cleanupOrder).toEqual([2, 1]);

    // A fresh ▶ builds a NEW root (not reusing the disposed one).
    await t.lifecycle.playSimulation();
    expect(t.mounted.length).toBe(2);
    t.lifecycle.stopSimulation();
    expect(t.unmountCount).toBe(2);
    expect(t.mounted[1]!.removed).toBe(true);
  });
});

// ── AC-06 — ■ Stop scene restore: despawn-runtime BEFORE re-instantiate + rebind ─
//
// Regression: Stop despawns the played scene and re-instantiates the SceneAsset,
// which mints FRESH handles under a NEW synthetic root. Two bugs this locks down:
//   (a) despawnRuntimeSpawns() must run BEFORE the re-instantiate — otherwise the
//       freshly restored scene's new handles (absent from the pre▶ baseline) get
//       swept away as "runtime spawns" and the scene vanishes.
//   (b) rebindSceneInstance(newRoot) must fire with the NEW root so the host can
//       re-sync the editor session map + defaultSceneRoot (else "scene not
//       restored" — hierarchy/selection point at despawned handles).

/** A fake world recording the ORDER of despawn / despawnScene / instantiateScene
 *  so we can assert runtime-spawn cleanup precedes scene re-instantiate. */
function makeOrderRecordingWorld() {
  const calls: string[] = [];
  let nextRoot = 1000;
  const world = {
    addSystem: (_s: unknown) => ({ ok: true }),
    insertResource: (_k: string, _v: unknown) => {},
    inspect: () => ({ systems: [] as ReadonlyArray<{ name: string }> }),
    removeSystem: () => ({ ok: true }),
    despawn: (_h: never) => {
      calls.push('despawn');
      return { ok: true };
    },
    getSceneInstanceState: (root: number) => ({
      ok: true,
      value: { source: { srcFor: root }, entityToLocalId: new Map<number, number>() },
    }),
    despawnScene: (_root: number) => {
      calls.push('despawnScene');
      return { ok: true, value: 1 };
    },
    instantiateScene: (_handle: unknown) => {
      calls.push('instantiateScene');
      nextRoot += 1;
      return { ok: true, value: { root: nextRoot } };
    },
    allocSharedRef: () => 0,
  };
  return { world, calls, get lastRoot() { return nextRoot; } };
}

describe('AC-06 — ■ Stop scene restore ordering + rebind', () => {
  function buildRestore(prePlay: Set<number>, postPlay: Set<number>) {
    const fw = makeOrderRecordingWorld();
    const bus = makeFakeBus();
    const game = makeFakeGame();
    const rebinds: number[] = [];
    // collectEntityHandles returns prePlay at ▶ capture, postPlay afterwards, so
    // the pre▶→now diff (postPlay \ prePlay) is the "runtime spawns" to despawn.
    let phase = 0;
    const lifecycle = createRunLifecycle({
      world: fw.world as never,
      app: { registerUpdate: () => {} },
      renderer: { assets: {} },
      bus: bus as never,
      collectEntityHandles: () => (phase++ === 0 ? prePlay : postPlay),
      resolveGameModule: async () => game.module,
      getSlug: () => 'restore-fake',
      getDefaultSceneRoot: () => 42,
      getDefaultScene: () => undefined,
      rebindSceneInstance: (r: number) => rebinds.push(r),
    });
    return { fw, lifecycle, rebinds };
  }

  it('despawns runtime spawns BEFORE despawnScene + re-instantiate', async () => {
    // One runtime spawn (handle 7) appeared during the run.
    const t = buildRestore(new Set([1, 2]), new Set([1, 2, 7]));
    await t.lifecycle.playSimulation();
    t.lifecycle.stopSimulation();
    // The single runtime-spawn despawn must precede despawnScene/instantiateScene.
    expect(t.fw.calls).toEqual(['despawn', 'despawnScene', 'instantiateScene']);
  });

  it('rebinds the session onto the NEW re-instantiated root', async () => {
    const t = buildRestore(new Set([1, 2]), new Set([1, 2]));
    await t.lifecycle.playSimulation();
    t.lifecycle.stopSimulation();
    expect(t.rebinds.length).toBe(1);
    expect(t.rebinds[0]).toBe(t.fw.lastRoot); // the root instantiateScene returned
  });
});
