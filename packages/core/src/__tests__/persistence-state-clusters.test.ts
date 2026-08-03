// persistence-state-clusters — M2 (w5) headless fake-deps safety net for the
// STATE-type persistence clusters extracted in w7:
//   - scene-list / switch  (createSceneList)
//   - play-config          (createPlayConfig)   ← the clean fetch-injection proof
//   - storage / retired doc mirror (createStorage)
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
import { assetIO } from '../io/asset-io-facade';
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

// ── storage / retired doc mirror ─────────────────────────────────────────────
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
      fetch: () => Promise.reject(new Error('fetch must not be called here')),
      resolveGamePath: (rel) => `/games/g1/${rel}`,
      assetIO,
      savePendingScene: () => Promise.resolve(false),
      clearPendingScene: () => ctx.setDirty(false),
      loadDocFromDisk: () => Promise.resolve(false),
      loadDocFromStorage: () => false,
      replaceDoc: (_d) => {},
      ...over,
    };
    return { sl: createSceneList(deps), ctx };
  }

  it('getters and the public read model read the same ctx', () => {
    const { sl, ctx } = make();
    ctx.currentSceneId = 'shoot';
    ctx.currentSceneFile = 'lvl1';
    ctx.currentSceneGuid = 'guid-lvl1';
    ctx.defaultSceneGuid = 'guid-lvl2';
    ctx.sceneList = [
      { id: 'lvl1', name: 'Level 1', pack: 'p', guid: 'guid-lvl1' },
      { id: 'lvl2', name: 'Level 2', pack: 'q', guid: 'guid-lvl2' },
    ];
    ctx.currentSceneEntities = [7, 9] as never;
    expect(sl.getSceneId()).toBe('shoot');
    expect(sl.getSceneFile()).toBe('lvl1');
    expect(sl.getSceneList()).toEqual([
      { id: 'lvl1', name: 'Level 1', pack: 'p', guid: 'guid-lvl1' },
      { id: 'lvl2', name: 'Level 2', pack: 'q', guid: 'guid-lvl2' },
    ]);
    expect(sl.getLoadedSceneEntities()).toEqual([7, 9]);
    expect(sl.getSceneReadModel()).toEqual({
      gameId: 'shoot',
      currentScene: { id: 'lvl1', guid: 'guid-lvl1' },
      defaultScene: { id: 'lvl2', guid: 'guid-lvl2' },
      scenes: [
        { id: 'lvl1', name: 'Level 1', pack: 'p', guid: 'guid-lvl1', isCurrent: true, isDefault: false },
        { id: 'lvl2', name: 'Level 2', pack: 'q', guid: 'guid-lvl2', isCurrent: false, isDefault: true },
      ],
    });
  });

  it('setDefaultScene writes and verifies forge.json before publishing the projection', async () => {
    const raw = { id: 'shoot', name: 'Shoot', schemaVersion: '1.0.0', entry: 'main.ts', defaultScene: 'guid-lvl1' };
    const verified = { ...raw, defaultScene: 'guid-lvl2' };
    const reads = [raw, verified];
    const writes: RequestInit[] = [];
    const { sl, ctx } = make({
      fetchWithTimeout: async () => new Response(JSON.stringify({ content: JSON.stringify(reads.shift()) })),
      fetch: async (_path, init) => { writes.push(init ?? {}); return new Response('{}', { status: 200 }); },
    });
    ctx.currentSceneId = 'shoot';
    ctx.defaultSceneGuid = 'guid-lvl1';
    ctx.sceneList = [
      { id: 'lvl1', name: 'Level 1', pack: 'p', guid: 'guid-lvl1' },
      { id: 'lvl2', name: 'Level 2', pack: 'q', guid: 'guid-lvl2' },
    ];
    const observed: number[] = [];
    const off = sl.onSceneListChange(() => observed.push(ctx.defaultSceneGuid === 'guid-lvl2' ? 1 : 0));

    const result = await sl.setDefaultScene('guid-lvl2', 'default-scene-1');
    off();
    expect(result).toEqual({
      ok: true,
      result: {
        requestId: 'default-scene-1',
        sceneGuid: 'guid-lvl2',
        sceneId: 'lvl2',
        previousSceneGuid: 'guid-lvl1',
        changed: true,
      },
    });
    expect(observed).toEqual([1]);
    expect(ctx.defaultSceneGuid).toBe('guid-lvl2');
    expect(writes).toHaveLength(1);
    const body = JSON.parse(String(writes[0]?.body)) as { path: string; content: string };
    expect(body.path).toBe('/games/g1/forge.json');
    expect(JSON.parse(body.content)).toEqual(verified);
  });

  it('setDefaultScene rejects an unknown GUID without network or projection changes', async () => {
    let writes = 0;
    const { sl, ctx } = make({ fetch: async () => { writes++; return new Response('{}'); } });
    ctx.currentSceneId = 'shoot';
    ctx.defaultSceneGuid = 'guid-lvl1';
    ctx.sceneList = [{ id: 'lvl1', name: 'Level 1', pack: 'p', guid: 'guid-lvl1' }];
    const result = await sl.setDefaultScene('not-a-scene', 'default-scene-invalid');
    expect(result).toMatchObject({ ok: false, error: { code: 'scene-default-invalid' } });
    expect(ctx.defaultSceneGuid).toBe('guid-lvl1');
    expect(writes).toBe(0);
  });

  it('deleteScene guards the current/default scene before touching assetIO', async () => {
    let reads = 0;
    const { sl, ctx } = make({
      assetIO: {
        readPack: async () => { reads++; return null; },
        deleteSourceFile: async () => ({ ok: true }),
        verifySourceFileAbsent: async () => ({ ok: true, absent: true }),
      },
    });
    ctx.currentSceneId = 'shoot';
    ctx.currentSceneFile = 'lvl1';
    ctx.currentSceneGuid = 'guid-lvl1';
    ctx.defaultSceneGuid = 'guid-lvl1';
    ctx.sceneList = [
      { id: 'lvl1', name: 'Level 1', pack: 'p', guid: 'guid-lvl1' },
      { id: 'lvl2', name: 'Level 2', pack: 'q', guid: 'guid-lvl2' },
    ];

    const result = await sl.deleteScene('guid-lvl1', 'delete-current-1');
    expect(result).toMatchObject({ ok: false, error: { code: 'scene-delete-guarded' } });
    if (!result.ok) expect(result.error.current).toMatchObject({ impact: { isCurrent: true, isDefault: true, referencedBy: [] } });
    expect(reads).toBe(0);
    expect(ctx.sceneList).toHaveLength(2);
  });

  it('deleteScene reports scene referrers before deleting a referenced scene', async () => {
    const packs = new Map([
      ['/games/g1/p', { schemaVersion: '1', kind: 'internal-text-package', assets: [{ guid: 'guid-lvl1', kind: 'scene', payload: {}, refs: ['guid-lvl2'] }] }],
      ['/games/g1/q', { schemaVersion: '1', kind: 'internal-text-package', assets: [{ guid: 'guid-lvl2', kind: 'scene', payload: {}, refs: [] }] }],
    ]);
    let deletes = 0;
    const { sl, ctx } = make({
      assetIO: {
        readPack: async (path) => packs.get(path) as never ?? null,
        deleteSourceFile: async () => { deletes++; return { ok: true }; },
        verifySourceFileAbsent: async () => ({ ok: true, absent: true }),
      },
    });
    ctx.currentSceneId = 'shoot';
    ctx.currentSceneFile = 'lvl1';
    ctx.currentSceneGuid = 'guid-lvl1';
    ctx.defaultSceneGuid = 'guid-lvl1';
    ctx.sceneList = [
      { id: 'lvl1', name: 'Level 1', pack: 'p', guid: 'guid-lvl1' },
      { id: 'lvl2', name: 'Level 2', pack: 'q', guid: 'guid-lvl2' },
    ];

    const result = await sl.deleteScene('guid-lvl2', 'delete-referenced-1');
    expect(result).toMatchObject({ ok: false, error: { code: 'scene-delete-guarded' } });
    if (!result.ok) expect(result.error.current).toMatchObject({ impact: { sceneGuid: 'guid-lvl2', referencedBy: [{ sceneId: 'lvl1', assetGuid: 'guid-lvl1' }] } });
    expect(deletes).toBe(0);
    expect(ctx.sceneList).toHaveLength(2);
  });

  it('deleteScene verifies the file before publishing a consistent list/default/current projection', async () => {
    const packs = new Map([
      ['/games/g1/p', { schemaVersion: '1', kind: 'internal-text-package', assets: [{ guid: 'guid-lvl1', kind: 'scene', payload: {}, refs: [] }] }],
      ['/games/g1/q', { schemaVersion: '1', kind: 'internal-text-package', assets: [{ guid: 'guid-lvl2', kind: 'scene', payload: {}, refs: [] }] }],
    ]);
    const deletedPaths: string[] = [];
    const { sl, ctx } = make({
      assetIO: {
        readPack: async (path) => packs.get(path) as never ?? null,
        deleteSourceFile: async (path) => { deletedPaths.push(path); return { ok: true }; },
        verifySourceFileAbsent: async () => ({ ok: true, absent: true }),
      },
    });
    ctx.currentSceneId = 'shoot';
    ctx.currentSceneFile = 'lvl1';
    ctx.currentSceneGuid = 'guid-lvl1';
    ctx.defaultSceneGuid = 'guid-lvl1';
    ctx.sceneList = [
      { id: 'lvl1', name: 'Level 1', pack: 'p', guid: 'guid-lvl1' },
      { id: 'lvl2', name: 'Level 2', pack: 'q', guid: 'guid-lvl2' },
    ];

    const result = await sl.deleteScene('guid-lvl2', 'delete-success-1');
    expect(result).toMatchObject({ ok: true, result: { sceneId: 'lvl2', sceneGuid: 'guid-lvl2', pack: 'q', currentScene: { id: 'lvl1', guid: 'guid-lvl1' }, defaultScene: { id: 'lvl1', guid: 'guid-lvl1' } } });
    expect(deletedPaths).toEqual(['/games/g1/q']);
    expect(ctx.sceneList).toEqual([{ id: 'lvl1', name: 'Level 1', pack: 'p', guid: 'guid-lvl1' }]);
    expect(sl.getSceneReadModel()).toMatchObject({ currentScene: { id: 'lvl1', guid: 'guid-lvl1' }, defaultScene: { id: 'lvl1', guid: 'guid-lvl1' }, scenes: [{ id: 'lvl1', isCurrent: true, isDefault: true }] });
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
    let saveCalls = 0;
    const { sl, ctx } = make({ savePendingScene: () => { saveCalls++; return Promise.resolve(true); } });
    ctx.currentSceneId = 'shoot';
    ctx.currentSceneFile = 'lvl1';
    ctx.sceneList = [{ id: 'lvl1', name: 'Level 1', pack: 'p' }];
    expect(await sl.doSwitchSceneFile('lvl1')).toBe(true);
    expect(saveCalls).toBe(0); // early return before applying a dirty policy
  });

  it('doSwitchSceneFile rejects an unknown scene id without side effects', async () => {
    let saveCalls = 0;
    const { sl, ctx } = make({ savePendingScene: () => { saveCalls++; return Promise.resolve(true); } });
    ctx.currentSceneId = 'shoot';
    ctx.currentSceneFile = 'lvl1';
    ctx.sceneList = [{ id: 'lvl1', name: 'Level 1', pack: 'p' }];
    expect(await sl.doSwitchSceneFile('nope')).toBe(false);
    expect(saveCalls).toBe(0);
  });

  it('dirty switch requires an explicit policy and never flushes implicitly', async () => {
    let saveCalls = 0;
    const { sl, ctx } = make({ savePendingScene: () => { saveCalls++; return Promise.resolve(true); } });
    ctx.currentSceneId = 'shoot';
    ctx.currentSceneFile = 'lvl1';
    ctx.sceneList = [
      { id: 'lvl1', name: 'Level 1', pack: 'p' },
      { id: 'lvl2', name: 'Level 2', pack: 'q' },
    ];
    ctx.isDirty = true;
    expect(await sl.doSwitchSceneFile('lvl2')).toBe(false);
    expect(ctx.currentSceneFile).toBe('lvl1');
    expect(ctx.isDirty).toBe(true);
    expect(saveCalls).toBe(0);
  });

  it('discard clears dirty before switching', async () => {
    const { sl, ctx } = make();
    ctx.currentSceneId = 'shoot';
    ctx.currentSceneFile = 'lvl1';
    ctx.sceneList = [
      { id: 'lvl1', name: 'Level 1', pack: 'p' },
      { id: 'lvl2', name: 'Level 2', pack: 'q' },
    ];
    ctx.isDirty = true;
    expect(await sl.doSwitchSceneFile('lvl2', 'discard')).toBe(true);
    expect(ctx.currentSceneFile).toBe('lvl2');
    expect(ctx.isDirty).toBe(false);
  });

  it('save policy persists before switching and preserves origin', async () => {
    const origins: string[] = [];
    const { sl, ctx } = make({ savePendingScene: (origin) => { origins.push(origin); return Promise.resolve(true); } });
    ctx.currentSceneId = 'shoot';
    ctx.currentSceneFile = 'lvl1';
    ctx.sceneList = [
      { id: 'lvl1', name: 'Level 1', pack: 'p' },
      { id: 'lvl2', name: 'Level 2', pack: 'q' },
    ];
    ctx.isDirty = true;
    expect(await sl.doSwitchSceneFile('lvl2', 'save', 'ai')).toBe(true);
    expect(ctx.currentSceneFile).toBe('lvl2');
    expect(origins).toEqual(['ai']);
  });
});
