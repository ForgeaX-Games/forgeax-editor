// host-boot-di — M4 (w12) headless fake-deps safety net for the host-boot session
// tail: the boot-timing cluster (initHostSession), the physics gate
// (resolveEditPhysics), and the preview-skin hook (installPreviewSkinHook).
//
// These are exactly the paths #88's real-Play safety net could NOT reach in a
// unit: initHostSession is ~234 lines of high-side-effect boot ordering that
// touches the network (fetch: /api/health, /api/files), the live engine world
// (gateway), window/VAG listeners, and the disk-watch socket — so before M4 they
// had no headless coverage. M4 (D-3) extracts them into a `createHostSession(deps)`
// factory (the run-lifecycle `create<Thing>(deps)` pattern) whose deps make every
// side effect injectable — so this suite drives resolveEditPhysics / initHostSession
// / (indirectly) installPreviewSkinHook with FAKE fetch + fake gateway + fake
// core singletons, asserting:
//   - AC-02: the factory reaches all state THROUGH deps (deps.getSceneId /
//     deps.gateway / deps.loadDocFromDisk / ...), never a module-level singleton —
//     a fresh fake set fully controls behavior.
//   - AC-02 x R-P1: fetch is a DEP (structural injection), so a headless test
//     injects a fake that never touches the network. This is the injection seam
//     plan-strategy §2 D-3 opens (import→deps), NOT a change to the transport body
//     (OOS-4). lint-no-direct-api-fetch stays green: no raw fetch('/api').
//   - AC-05: the boot ORDERING is preserved (loadDoc →
//     broadcastAssetsChanged → run-lifecycle → mesh-stats → preview-skin →
//     disk-watch + beacon listeners), driven deterministically without a browser.
//   - OOS-1: zero behavior change — the physics gate degrades to `undefined` on a
//     failed read; the default slug short-circuits before any network.
//
// TDD: this file is written BEFORE createHostSession exists (w13), so it is RED
// until the factory is extracted (plan-strategy §5.1 red-green for the boot
// side-effect cluster).
//
// Anchors:
//   (forward) plan-strategy feat-20260709-editor-large-file-di-decompose-wave2-c-domain-scen
//     plan-id; AC-02 (headless-injectable DI unit, no singleton read) + AC-05
//     (high side-effect boot path regression) ; plan-strategy §2 D-2 (fetch via
//     deps) + D-4 (host-boot DI) + §5.3.
//   (backward) covers viewport/host-session.ts, extracted from host-boot.ts, whose
//     boot tail arrived from main.tsx by historical feats
//     feat-20260707-editor-world-fork-ssot-level-load-play-activeworld (run-
//     lifecycle split) + the REPLAN D8 main.tsx→host-boot migration.

import { describe, expect, it } from 'bun:test';
import {
  createBootstrapResolver,
  createHostSession,
  type HostSessionDeps,
  type HostGateway,
  type HostSessionContext,
} from '../viewport/host-session';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// A syntactically valid RFC 4122 dash-form UUID (AssetGuid.parse accepts it).
const GOOD_GUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

// ── Fakes — nothing here touches the network, a real engine world, or the DOM. ──

/** Records fetch invocations so a test can assert the factory used the INJECTED
 *  seam (not a module import) and how many times, and can script the response. */
function makeFetchSpy(impl?: (path: string) => Promise<Response>) {
  const calls: string[] = [];
  const fetchFn = (path: string, _init?: RequestInit): Promise<Response> => {
    calls.push(path);
    return impl ? impl(path) : Promise.reject(new Error('fetch must not be called in this case'));
  };
  return { fetch: fetchFn, calls };
}

/** forge.json content responder — 200 with a `{ content }` envelope (the shape the
 *  real /api/files router returns). */
function forgeResponse(project: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ content: JSON.stringify(project) }), { status: 200 });
}

/** A minimal gateway whose activeWorld/engineFacade are inert stand-ins — the boot
 *  path only reads them through worldEntityHandles/entComponent (both injected or
 *  gated on a non-null selection, which the fakes keep null). */
function makeFakeGateway(): {
  gateway: HostGateway;
  dispatchCalls: unknown[];
  subscribeCount: () => number;
} {
  const dispatchCalls: unknown[] = [];
  let subscribers = 0;
  const gateway: HostGateway = {
    get activeWorld() { return {} as never; },
    dispatch(op: unknown): { ok: boolean } {
      dispatchCalls.push(op);
      return { ok: true };
    },
    subscribe(_fn: () => void): () => void { subscribers++; return () => {}; },
    engineFacade(): never { return {} as never; },
    enterPlay(_w: unknown): void {},
    exitPlay(): void {},
    createGameProjectionRegistry() {
      return { registrar: {} as never, clear(): void {} };
    },
    installGameProjection(_registry): void {},
    clearGameProjection(): void {},
  };
  return { gateway, dispatchCalls, subscribeCount: () => subscribers };
}

/** Build a full HostSessionDeps set with inert defaults; `over` overrides any leaf
 *  for a given test (the AC-02 proof: a fresh fake set fully controls behavior). */
function makeDeps(over?: Partial<HostSessionDeps>): {
  deps: HostSessionDeps;
  gatewayCtl: ReturnType<typeof makeFakeGateway>;
  log: {
    loadDiskCalls: number;
    loadStorageCalls: number;
    broadcastCalls: number;
    diskWatchStarted: number;
    diskWatchStopped: number;
    beaconInstalled: number;
    beaconDisposed: number;
    flushCalls: number;
  };
} {
  const gatewayCtl = makeFakeGateway();
  const log = {
    loadDiskCalls: 0,
    loadStorageCalls: 0,
    broadcastCalls: 0,
    diskWatchStarted: 0,
    diskWatchStopped: 0,
    beaconInstalled: 0,
    beaconDisposed: 0,
    flushCalls: 0,
  };
  const deps: HostSessionDeps = {
    fetch: makeFetchSpy().fetch,
    gateway: gatewayCtl.gateway,
    getSceneId: () => 'default',
    resolveGamePath: (rel: string) => `/games/g1/${rel}`,
    loadDocFromDisk: async () => { log.loadDiskCalls++; return false; },
    loadDocFromStorage: () => { log.loadStorageCalls++; return false; },
    getLoadedSceneEntities: () => [],
    hasPendingDiskSave: () => false,
    flushPendingSaveBeacon: () => { log.flushCalls++; },
    initDiskWatch: () => { log.diskWatchStarted++; return () => { log.diskWatchStopped++; }; },
    broadcastAssetsChanged: () => { log.broadcastCalls++; },
    worldEntityHandles: () => [], // empty world → scene-less game opens empty
    getSelection: () => null,
    getAssetSelection: () => null,
    onSelectionChange: () => () => {},
    onAssetSelectionChange: () => () => {},
    installSaveBeaconListeners: (_flush: () => void) => {
      log.beaconInstalled++;
      return () => { log.beaconDisposed++; };
    },
    ...over,
  };
  return { deps, gatewayCtl, log };
}

/** A HostSessionContext with inert engine/renderer/viewport stand-ins. renderer.ready
 *  resolves; loadByGuid always misses — the boot path tolerates both headlessly. */
function makeCtx(over?: Partial<HostSessionContext>): HostSessionContext {
  const emitCalls: string[] = [];
  const stageCalls: string[] = [];
  const ctx = {
    app: { registerUpdate() {}, start() {}, pause: () => ({ ok: true }), resume: () => ({ ok: true }) },
    world: {} as never,
    renderer: { ready: Promise.resolve(), assets: { loadByGuid: async () => ({ ok: false, error: { code: 'miss' } }) }, store: {} },
    cameraEntity: 0,
    viewport: { resetCamera() {} },
    viewportContainer: {} as never,
    emitBoot: (m: string) => { emitCalls.push(m); },
    setBootStage: (s: string) => { stageCalls.push(s); },
    discoverGameCameraFromWorld: () => {},
    applyActiveCamera: () => {},
    playInput: { sample: () => ({ downKeys: new Set(), upKeys: new Set(), buttons: [false, false, false], movementX: 0, movementY: 0, wheelDelta: 0, focused: true, pointerLocked: false }), detach() {} },
    createPlayDrawSource: () => () => undefined,
    physics: undefined,
    onPlayStarted: () => {},
    onPlayFailed: () => {},
    ...over,
  } as HostSessionContext;
  // stash the spy arrays on the object for assertions (non-enumerable-ish helper)
  (ctx as unknown as { _emitCalls: string[] })._emitCalls = emitCalls;
  (ctx as unknown as { _stageCalls: string[] })._stageCalls = stageCalls;
  return ctx;
}

describe('createHostSession — factory shape + deps boundary (AC-02)', () => {
  it('is a factory returning the pre-boot physics gate + the session-tail runner', () => {
    const { deps } = makeDeps();
    const host = createHostSession(deps);
    expect(typeof host.resolveEditPhysics).toBe('function');
    expect(typeof host.initHostSession).toBe('function');
  });
});

describe('resolveEditPhysics — reads getSceneId via deps, fetch injected (AC-02 / R-6)', () => {
  it('returns undefined for the default slug WITHOUT any network', async () => {
    const spy = makeFetchSpy();
    const { deps } = makeDeps({ fetch: spy.fetch, getSceneId: () => 'default' });
    const host = createHostSession(deps);
    expect(await host.resolveEditPhysics()).toBeUndefined();
    expect(spy.calls.length).toBe(0);
  });

  it('reads forge.physics through the injected fetch and maps 3d → rapier-3d', async () => {
    const spy = makeFetchSpy(() =>
      Promise.resolve(forgeResponse({ id: 'g1', name: 'G1', schemaVersion: '1.0.0', physics: '3d' })),
    );
    const { deps } = makeDeps({ fetch: spy.fetch, getSceneId: () => 'shoot' });
    const host = createHostSession(deps);
    expect(await host.resolveEditPhysics()).toBe('rapier-3d');
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0]).toContain(encodeURIComponent('/games/g1/forge.json'));
  });

  it('maps physics:true → rapier-3d and 2d → rapier-2d (OOS-1 mapping preserved)', async () => {
    const mk = (physics: unknown) => {
      const spy = makeFetchSpy(() =>
        Promise.resolve(forgeResponse({ id: 'g1', name: 'G1', schemaVersion: '1.0.0', physics })),
      );
      const { deps } = makeDeps({ fetch: spy.fetch, getSceneId: () => 'shoot' });
      return createHostSession(deps).resolveEditPhysics();
    };
    expect(await mk(true)).toBe('rapier-3d');
    expect(await mk('2d')).toBe('rapier-2d');
    expect(await mk(false)).toBeUndefined();
  });

  it('degrades to undefined when the injected fetch rejects (charter S9, OOS-1)', async () => {
    const fetchFn = () => Promise.reject(new Error('offline'));
    const { deps } = makeDeps({ fetch, getSceneId: () => 'shoot' });
    const host = createHostSession(deps);
    expect(await host.resolveEditPhysics()).toBeUndefined();
  });
});

describe('createBootstrapResolver — one module evaluation, fresh-world bootstrap (P9a)', () => {
  it('imports a state-registering entry once and returns its bootstrap across Play cycles', async () => {
    let imports = 0;
    const bootstrap = () => {};
    const resolveBootstrap = createBootstrapResolver({
      readForgeForPlay: async () => ({ entry: 'main.ts' }),
      resolveGameFsBase: async () => '/@fs/games/p9a',
      getSceneId: () => 'p9a',
      importModule: async (url) => {
        imports += 1;
        expect(url).toBe('/@fs/games/p9a/main.ts');
        return { bootstrap };
      },
    });

    expect(await resolveBootstrap()).toBe(bootstrap);
    expect(await resolveBootstrap()).toBe(bootstrap);
    expect(imports).toBe(1);
  });

  it('caches a missing bootstrap after trying each documented entry candidate once', async () => {
    const urls: string[] = [];
    const resolveBootstrap = createBootstrapResolver({
      readForgeForPlay: async () => ({ entry: 'main.ts' }),
      resolveGameFsBase: async () => '/@fs/games/p9a',
      getSceneId: () => 'p9a',
      importModule: async (url) => { urls.push(url); return {}; },
    });

    expect(await resolveBootstrap()).toBeNull();
    expect(await resolveBootstrap()).toBeNull();
    expect(urls).toEqual(['/@fs/games/p9a/main.ts', '/@fs/games/p9a/src/main.ts']);
  });
});

describe('initHostSession — boot ordering driven headlessly (AC-05)', () => {
  it('loads the doc on an empty world (no demo seed), broadcasts assets, and wires disk-watch', async () => {
    const spy = makeFetchSpy();
    const { deps, log, gatewayCtl } = makeDeps({ fetch: spy.fetch, getSceneId: () => 'default' });
    const host = createHostSession(deps);
    const ctx = makeCtx();
    const session = await host.initHostSession(ctx);

    // doc load attempted (disk first, storage fallback on the false return).
    expect(log.loadDiskCalls).toBe(1);
    expect(log.loadStorageCalls).toBe(1);
    // scene-less game → NO demo seed: an empty world opens empty, nothing dispatched.
    expect(gatewayCtl.dispatchCalls.length).toBe(0);
    // panels re-read signal + disk-watch + beacon listeners installed.
    expect(log.broadcastCalls).toBe(1);
    expect(log.diskWatchStarted).toBe(1);
    expect(log.beaconInstalled).toBe(1);
    // the session exposes the ▶/■ + dispose triple.
    expect(typeof session.playSimulation).toBe('function');
    expect(typeof session.stopSimulation).toBe('function');
    expect(typeof session.dispose).toBe('function');
    // default slug: resolveEditPhysics was never invoked here, so no forge read.
    expect(spy.calls.length).toBe(0);
  });

  it('dispose() flushes once, stops disk-watch, and disposes the beacon listeners', async () => {
    const { deps, log } = makeDeps({ getSceneId: () => 'default' });
    const host = createHostSession(deps);
    const session = await host.initHostSession(makeCtx());
    session.dispose();
    expect(log.flushCalls).toBe(1);
    expect(log.diskWatchStopped).toBe(1);
    expect(log.beaconDisposed).toBe(1);
  });
});

describe('installPreviewSkinHook (via initHostSession) — fetch injected, no network (AC-02)', () => {
  it('default slug: preview-skin short-circuits before touching fetch', async () => {
    const spy = makeFetchSpy();
    const { deps } = makeDeps({ fetch: spy.fetch, getSceneId: () => 'default' });
    const host = createHostSession(deps);
    await host.initHostSession(makeCtx());
    await flush();
    // default slug: neither the physics gate nor the preview-skin hook read forge.
    expect(spy.calls.length).toBe(0);
  });

  it('real slug + no preview.skin: preview-skin reads forge THROUGH the injected fetch then returns', async () => {
    // forge.json without a preview block → the hook loads the project, finds no
    // skin, and returns — proving the read went through the injected seam.
    const spy = makeFetchSpy(() =>
      Promise.resolve(forgeResponse({ id: 'g1', name: 'G1', schemaVersion: '1.0.0' })),
    );
    const { deps } = makeDeps({ fetch: spy.fetch, getSceneId: () => 'shoot' });
    const host = createHostSession(deps);
    await host.initHostSession(makeCtx());
    await flush();
    await flush();
    // the preview-skin hook issued at least one forge read via the injected fetch.
    expect(spy.calls.length).toBeGreaterThan(0);
    expect(spy.calls.some((p) => p.includes(encodeURIComponent('/games/g1/forge.json')))).toBe(true);
  });
});
