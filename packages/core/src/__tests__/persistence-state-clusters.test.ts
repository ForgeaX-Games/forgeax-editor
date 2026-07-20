// persistence-state-clusters — M2 (w5) headless fake-deps safety net for the
// STATE-type persistence clusters extracted in w7:
//   - scene-list / switch  (createSceneList)
//   - play-config          (createPlayConfig)   ← the clean fetch-injection proof
//   - storage / hidden-key (createStorage)
//
// Each cluster is a `create<Thing>(deps)` factory that reaches all state THROUGH
// deps (deps.ctx) — a fresh fake ctx fully controls behavior, so nothing reads a
// module-level singleton (AC-02). play-config additionally takes fetch as a
// dep (R-P1 / D-2 structural injection); this suite injects a fake fetch and
// asserts read/write route through it with NO network — the positive proof that
// the seam is import→deps, not a change to the transport body (OOS-4).
//
// OOS-1: the extracted bodies are behaviorally identical — default-slug guards
// still return campaign / false without any I/O; switch validation still rejects
// an unknown scene id.
//
// TDD: written BEFORE the w7 factories exist, so RED until they are extracted
// (plan-strategy §5.2).
//
// Anchors:
//   (forward) plan-strategy feat-20260709-editor-large-file-di-decompose-wave2-c-domain-scen
//     plan-id; AC-02 (headless-injectable DI unit, no singleton read); plan-strategy
//     §7 M2 (scene-list/switch · play-config · storage cluster split) + §5.2.
//   (backward) covers store/persistence/{scene-list,play-config,storage}.ts,
//     extracted from scene-persistence.ts (split from store.ts by historical feat
//     feat-20260705-editor-core-engine-convergence-store-ts-decompose).

import { describe, expect, it } from 'bun:test';
import { createSceneList, type SceneListDeps } from '../store/persistence/scene-list';
import { createPlayConfig, type PlayConfigDeps } from '../store/persistence/play-config';
import { createStorage, type StorageDeps } from '../store/persistence/storage';
import type { PersistenceGateway } from '../store/persistence/disk-io';
import { createScenePersistenceContext, type ScenePersistenceContext } from '../store/scene-persistence';
import type { EditSession } from '../types';

function fakeGateway(): PersistenceGateway {
  return {
    doc: { world: null as never, registry: undefined },
    replaceDoc(_d: EditSession): void {},
    dispatch(_op: unknown): { ok: true } { return { ok: true }; },
  };
}

// ── play-config: fetch is a dep (R-P1) ─────────────────────────────────────
describe('createPlayConfig — fetch injected, no network (AC-02 / R-P1)', () => {
  function deps(over?: Partial<PlayConfigDeps>): { deps: PlayConfigDeps; ctx: ScenePersistenceContext } {
    const ctx = over?.ctx ?? createScenePersistenceContext();
    return {
      ctx,
      deps: {
        ctx,
        fetch: () => Promise.reject(new Error('fetch must not be called here')),
        resolveGamePath: (rel) => `/games/g1/${rel}`,
        ...over,
      },
    };
  }

  it('readPlayConfig returns campaign for the default slug WITHOUT calling fetch', async () => {
    let calls = 0;
    const { deps: d, ctx } = deps({ fetch: () => { calls++; return Promise.reject(new Error('no')); } });
    ctx.currentSceneId = 'default';
    const pc = createPlayConfig(d);
    expect(await pc.readPlayConfig()).toEqual({ mode: 'campaign' });
    expect(calls).toBe(0);
  });

  it('readPlayConfig parses the config returned by the INJECTED fetch', async () => {
    const calls: string[] = [];
    const { deps: d, ctx } = deps({
      fetch: (path) => {
        calls.push(path);
        return Promise.resolve(new Response(JSON.stringify({ content: JSON.stringify({ mode: 'level', sceneGuid: '11111111-2222-4333-8444-555555555555' }) }), { status: 200 }));
      },
    });
    ctx.currentSceneId = 'shoot';
    const pc = createPlayConfig(d);
    expect(await pc.readPlayConfig()).toEqual({
      mode: 'level',
      sceneGuid: '11111111-2222-4333-8444-555555555555',
    });
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain(encodeURIComponent('/games/g1/play-config.json'));
    expect(calls[0]).toContain('optional=1');
  });

  it('writePlayConfig POSTs through the injected fetch and returns its ok', async () => {
    const posts: Array<{ path: string; init?: RequestInit }> = [];
    const { deps: d, ctx } = deps({
      fetch: (path, init) => { posts.push({ path, init }); return Promise.resolve(new Response('', { status: 200 })); },
    });
    ctx.currentSceneId = 'shoot';
    const pc = createPlayConfig(d);
    expect(await pc.writePlayConfig({ mode: 'campaign' })).toBe(true);
    expect(posts.length).toBe(1);
    expect(posts[0]?.init?.method).toBe('POST');
  });

  it('writePlayConfig returns false for the default slug without any network', async () => {
    let calls = 0;
    const { deps: d, ctx } = deps({ fetch: () => { calls++; return Promise.reject(new Error('no')); } });
    ctx.currentSceneId = 'default';
    const pc = createPlayConfig(d);
    expect(await pc.writePlayConfig({ mode: 'campaign' })).toBe(false);
    expect(calls).toBe(0);
  });
});

// ── storage / hidden-key ──────────────────────────────────────────────────────
describe('createStorage — reads ctx via deps (AC-02)', () => {
  function make(): { s: ReturnType<typeof createStorage>; ctx: ScenePersistenceContext } {
    const ctx = createScenePersistenceContext();
    const deps: StorageDeps = { ctx };
    return { s: createStorage(deps), ctx };
  }

  it('loadDocFromStorage stays retired (always false, AC-15 / OOS-1)', () => {
    const { s } = make();
    expect(s.loadDocFromStorage()).toBe(false);
  });

  it('buildHiddenKey derives from ctx state and explicit overrides', () => {
    const { s, ctx } = make();
    ctx.currentSceneId = 'shoot';
    ctx.currentSceneFile = 'lvl1';
    expect(s.buildHiddenKey()).toBe('forgeax:editor:hidden:v1:shoot:lvl1');
    // explicit sceneFile=null collapses to the single-scene shape
    expect(s.buildHiddenKey('other', null)).toBe('forgeax:editor:hidden:v1:other');
    expect(s.buildHiddenKey('other', 'main')).toBe('forgeax:editor:hidden:v1:other:main');
  });

  it('clearDocStorage does not throw in a headless env', () => {
    const { s } = make();
    expect(() => s.clearDocStorage()).not.toThrow();
  });
});

// ── scene-list / switch ───────────────────────────────────────────────────────
describe('createSceneList — state via ctx, no network on the guarded paths (AC-02)', () => {
  function make(over?: Partial<SceneListDeps>): { sl: ReturnType<typeof createSceneList>; ctx: ScenePersistenceContext } {
    const ctx = over?.ctx ?? createScenePersistenceContext();
    const deps: SceneListDeps = {
      ctx,
      gateway: fakeGateway(),
      fetchWithTimeout: () => Promise.reject(new Error('fetchWithTimeout must not be called here')),
      resolveGamePath: (rel) => `/games/g1/${rel}`,
      flushPendingSaveBeacon: () => {},
      loadDocFromDisk: () => Promise.resolve(false),
      loadDocFromStorage: () => false,
      replaceDoc: (_d) => {},
      ...over,
    };
    return { sl: createSceneList(deps), ctx };
  }

  it('getSceneId / getSceneFile / getSceneList / getLoadedSceneEntities read ctx', () => {
    const { sl, ctx } = make();
    ctx.currentSceneId = 'shoot';
    ctx.currentSceneFile = 'lvl1';
    ctx.sceneList = [{ id: 'lvl1', name: 'Level 1', pack: 'p' }];
    ctx.currentSceneEntities = [7, 9] as never;
    expect(sl.getSceneId()).toBe('shoot');
    expect(sl.getSceneFile()).toBe('lvl1');
    expect(sl.getSceneList()).toEqual([{ id: 'lvl1', name: 'Level 1', pack: 'p' }]);
    expect(sl.getLoadedSceneEntities()).toEqual([7, 9]);
  });

  it('initSceneList on the default slug clears the list + file without any network', async () => {
    let fetchCalls = 0;
    const { sl, ctx } = make({ fetchWithTimeout: () => { fetchCalls++; return Promise.reject(new Error('no')); } });
    ctx.currentSceneId = 'default';
    ctx.sceneList = [{ id: 'stale', name: 's', pack: 'p' }];
    ctx.currentSceneFile = 'stale';
    await sl.initSceneList();
    expect(ctx.sceneList).toEqual([]);
    expect(ctx.currentSceneFile).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  it('onSceneListChange fires on initSceneList and unsubscribes cleanly', async () => {
    const { sl, ctx } = make();
    ctx.currentSceneId = 'default';
    let fired = 0;
    const off = sl.onSceneListChange(() => { fired++; });
    await sl.initSceneList();
    expect(fired).toBe(1);
    off();
    await sl.initSceneList();
    expect(fired).toBe(1); // no further callbacks after unsubscribe
  });

  it('doSwitchSceneFile is a no-op returning true when the id is already current', async () => {
    let beaconCalls = 0;
    const { sl, ctx } = make({ flushPendingSaveBeacon: () => { beaconCalls++; } });
    ctx.currentSceneId = 'shoot';
    ctx.currentSceneFile = 'lvl1';
    ctx.sceneList = [{ id: 'lvl1', name: 'Level 1', pack: 'p' }];
    expect(await sl.doSwitchSceneFile('lvl1')).toBe(true);
    expect(beaconCalls).toBe(0); // early return before flushing
  });

  it('doSwitchSceneFile rejects an unknown scene id without side effects', async () => {
    let beaconCalls = 0;
    const { sl, ctx } = make({ flushPendingSaveBeacon: () => { beaconCalls++; } });
    ctx.currentSceneId = 'shoot';
    ctx.currentSceneFile = 'lvl1';
    ctx.sceneList = [{ id: 'lvl1', name: 'Level 1', pack: 'p' }];
    expect(await sl.doSwitchSceneFile('nope')).toBe(false);
    expect(beaconCalls).toBe(0);
  });
});
