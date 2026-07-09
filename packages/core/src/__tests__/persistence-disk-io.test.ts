// persistence-disk-io — M2 (w4) headless fake-deps safety net for the HIGH
// SIDE-EFFECT persistence cluster (disk load / save / scene-load / beacon).
//
// These are exactly the paths #88's real-Play safety net could NOT reach: they
// touch the network (apiFetch / fetchWithTimeout) and the live engine world, so
// before M2 they had no headless coverage. M2 (D-3) extracts them into a
// `createDiskIo(deps)` factory whose deps make every side effect injectable — so
// this suite drives save / load / loadByGuid / flushPendingSaveBeacon with FAKE
// apiFetch + fetchWithTimeout + gateway, asserting:
//   - AC-02: the factory reaches all state THROUGH deps (deps.ctx / deps.gateway),
//     never a module-level singleton — a fresh fake ctx fully controls behavior.
//   - AC-02 × R-6: apiFetch is a DEP (structural injection), so a headless test
//     injects a fake that never touches the network. This is the injection seam
//     plan-strategy §2 D-3 opens (import→deps), NOT a change to the transport body
//     (OOS-4). lint-no-direct-api-fetch stays green: no raw fetch('/api').
//   - OOS-1: the extracted bodies are behaviorally identical — a serialize
//     failure still ABORTS the write (never POSTs an empty body over a good
//     scene, the 0-byte data-loss guard, AGENTS.md #2).
//
// TDD: this file is written BEFORE createDiskIo exists (w6), so it is RED until
// the factory is extracted (plan-strategy §5.1 red-green for the side-effect
// cluster).
//
// Anchors:
//   (forward) plan-strategy feat-20260709-editor-large-file-di-decompose-wave2-c-domain-scen
//     plan-id; AC-02 (headless-injectable DI unit, no singleton read) + AC-05
//     (high side-effect save/load path regression) ; plan-strategy §2 D-3 (apiFetch
//     via deps) + §5.3.
//   (backward) covers store/persistence/disk-io.ts, extracted from
//     scene-persistence.ts (itself split from store.ts by historical feat
//     feat-20260705-editor-core-engine-convergence-store-ts-decompose).

import { describe, expect, it } from 'bun:test';
import { createDiskIo, type DiskIoDeps, type PersistenceGateway } from '../store/persistence/disk-io';
import { createScenePersistenceContext, type ScenePersistenceContext } from '../store/scene-persistence';
import type { EditSession } from '../types';

// ── Fakes — nothing here touches the network or a real engine world. ──────────

/** A gateway whose `doc` carries a null world/registry (headless): serialization
 *  short-circuits (worldToPack returns null) so save aborts without a POST — the
 *  behavior we assert instead of standing up a real engine World. */
function makeFakeGateway(doc?: Partial<EditSession>): {
  gateway: PersistenceGateway;
  replaceCalls: EditSession[];
  dispatchCalls: unknown[];
} {
  const replaceCalls: EditSession[] = [];
  const dispatchCalls: unknown[] = [];
  const gateway: PersistenceGateway = {
    doc: { world: (doc?.world ?? null) as never, registry: doc?.registry },
    replaceDoc(d: EditSession): void { replaceCalls.push(d); },
    dispatch(op: unknown): { ok: true } { dispatchCalls.push(op); return { ok: true }; },
  };
  return { gateway, replaceCalls, dispatchCalls };
}

/** Records apiFetch / fetchWithTimeout invocations so a test can assert the
 *  factory used the INJECTED seam (not a module import) and how many times. */
function makeNetSpies(opts?: {
  apiFetchImpl?: (path: string, init?: RequestInit) => Promise<Response>;
  fetchImpl?: (url: string) => Promise<Response>;
}) {
  const apiFetchCalls: Array<{ path: string; init?: RequestInit }> = [];
  const fetchCalls: string[] = [];
  const apiFetch = (path: string, init?: RequestInit): Promise<Response> => {
    apiFetchCalls.push({ path, init });
    return opts?.apiFetchImpl
      ? opts.apiFetchImpl(path, init)
      : Promise.reject(new Error('apiFetch must not be called in this case'));
  };
  const fetchWithTimeout = (url: string): Promise<Response> => {
    fetchCalls.push(url);
    return opts?.fetchImpl
      ? opts.fetchImpl(url)
      : Promise.reject(new Error('fetchWithTimeout must not be called in this case'));
  };
  return { apiFetch, fetchWithTimeout, apiFetchCalls, fetchCalls };
}

function makeDeps(over?: Partial<DiskIoDeps>): {
  deps: DiskIoDeps;
  ctx: ScenePersistenceContext;
} {
  const ctx = over?.ctx ?? createScenePersistenceContext();
  const { gateway } = makeFakeGateway();
  const net = makeNetSpies();
  const deps: DiskIoDeps = {
    ctx,
    gateway,
    apiFetch: net.apiFetch,
    fetchWithTimeout: net.fetchWithTimeout,
    resolveGamePath: (rel: string) => `/games/g1/${rel}`,
    notifyDocChanged: () => {},
    ...over,
  };
  return { deps, ctx };
}

describe('createDiskIo — factory shape + deps boundary (AC-02)', () => {
  it('is a factory returning the high-side-effect surface', () => {
    const { deps } = makeDeps();
    const io = createDiskIo(deps);
    expect(typeof io.scenePath).toBe('function');
    expect(typeof io.worldToPack).toBe('function');
    expect(typeof io.loadSceneByGuid).toBe('function');
    expect(typeof io.doLoadDocFromDisk).toBe('function');
    expect(typeof io.doSaveDocToDisk).toBe('function');
    expect(typeof io.flushPendingSaveBeacon).toBe('function');
    expect(typeof io.instantiateSceneRefUnderWorld).toBe('function');
    expect(typeof io.replaceDoc).toBe('function');
    expect(typeof io.inlineAssetCount).toBe('function');
  });
});

describe('scenePath — reads ctx via deps, no network (AC-02)', () => {
  it('returns null for the default game slug WITHOUT resolving a path or hitting net', () => {
    let resolveCalls = 0;
    const { deps, ctx } = makeDeps({ resolveGamePath: (rel) => { resolveCalls++; return `/g/${rel}`; } });
    ctx.currentSceneId = 'default';
    const io = createDiskIo(deps);
    expect(io.scenePath()).toBeNull();
    expect(resolveCalls).toBe(0);
  });

  it('resolves scene.pack.json when a game is active and no scene file is bound', () => {
    const { deps, ctx } = makeDeps();
    ctx.currentSceneId = 'shoot';
    ctx.currentSceneFile = null;
    const io = createDiskIo(deps);
    expect(io.scenePath()).toBe('/games/g1/scene.pack.json');
  });

  it('resolves the bound scene file entry pack when currentSceneFile is set', () => {
    const { deps, ctx } = makeDeps();
    ctx.currentSceneId = 'shoot';
    ctx.currentSceneFile = 'lvl1';
    ctx.sceneList = [{ id: 'lvl1', name: 'Level 1', pack: 'assets/scenes/lvl1.pack.json' }];
    const io = createDiskIo(deps);
    expect(io.scenePath()).toBe('/games/g1/assets/scenes/lvl1.pack.json');
  });
});

describe('doSaveDocToDisk — serialize-fail aborts, never POSTs (OOS-1 / R-6)', () => {
  it('returns false and NEVER calls apiFetch when the world is headless (serialize fails)', async () => {
    const net = makeNetSpies();
    const { deps, ctx } = makeDeps({ apiFetch: net.apiFetch, fetchWithTimeout: net.fetchWithTimeout });
    ctx.currentSceneId = 'shoot';
    ctx.isDirty = true;
    const io = createDiskIo(deps);
    const ok = await io.doSaveDocToDisk();
    expect(ok).toBe(false);
    // The 0-byte data-loss guard: no write attempted over a good on-disk scene.
    expect(net.apiFetchCalls.length).toBe(0);
    // Save aborted before clearing dirty → the next save can retry.
    expect(ctx.isDirty).toBe(true);
  });

  it('returns false for the default slug (no scenePath) without any network', async () => {
    const net = makeNetSpies();
    const { deps, ctx } = makeDeps({ apiFetch: net.apiFetch, fetchWithTimeout: net.fetchWithTimeout });
    ctx.currentSceneId = 'default';
    const io = createDiskIo(deps);
    expect(await io.doSaveDocToDisk()).toBe(false);
    expect(net.apiFetchCalls.length).toBe(0);
    expect(net.fetchCalls.length).toBe(0);
  });
});

describe('doLoadDocFromDisk — uses the injected fetchWithTimeout, resets guid (AC-02)', () => {
  it('returns false for the default slug without touching the injected net', async () => {
    const net = makeNetSpies();
    const { deps, ctx } = makeDeps({ apiFetch: net.apiFetch, fetchWithTimeout: net.fetchWithTimeout });
    ctx.currentSceneId = 'default';
    const io = createDiskIo(deps);
    expect(await io.doLoadDocFromDisk()).toBe(false);
    expect(net.fetchCalls.length).toBe(0);
  });

  it('reads THIS scene path through the injected fetchWithTimeout and captures the pack guid', async () => {
    // A valid pack with a scene asset GUID; the load then reaches loadSceneByGuid
    // which returns false headlessly (null world) — so the doc does not change,
    // but we prove the read went through the injected seam + guid was captured.
    const guid = '11111111-2222-5333-8444-555555555555';
    const packJson = JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'internal-text-package',
      assets: [{ guid, kind: 'scene', payload: { entities: [] }, refs: [] }],
    });
    const net = makeNetSpies({
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify({ content: packJson }), { status: 200 })),
    });
    const { deps, ctx } = makeDeps({ apiFetch: net.apiFetch, fetchWithTimeout: net.fetchWithTimeout });
    ctx.currentSceneId = 'shoot';
    const io = createDiskIo(deps);
    const ok = await io.doLoadDocFromDisk();
    expect(ok).toBe(false); // loadSceneByGuid fails on the headless (null) world
    expect(net.fetchCalls.length).toBe(1);
    expect(net.fetchCalls[0]).toContain(encodeURIComponent('/games/g1/scene.pack.json'));
    // The guid was captured off the pack before the (failed) engine load.
    expect(ctx.currentSceneGuid).toBe(guid);
  });
});

describe('loadSceneByGuid — headless world short-circuits (AC-02)', () => {
  it('returns false when gateway.doc has no world/registry', async () => {
    const { deps } = makeDeps();
    const io = createDiskIo(deps);
    expect(await io.loadSceneByGuid('11111111-2222-5333-8444-555555555555')).toBe(false);
  });
});

describe('flushPendingSaveBeacon — respects the dirty flag on the injected ctx (OOS-1)', () => {
  it('is a no-op (no scenePath resolve, no serialize) when ctx is clean', () => {
    let resolveCalls = 0;
    const { deps, ctx } = makeDeps({ resolveGamePath: (rel) => { resolveCalls++; return `/g/${rel}`; } });
    ctx.currentSceneId = 'shoot';
    ctx.isDirty = false;
    const io = createDiskIo(deps);
    io.flushPendingSaveBeacon();
    // clean → returns before resolving a path or serializing.
    expect(resolveCalls).toBe(0);
    expect(ctx.isDirty).toBe(false);
  });
});

describe('inlineAssetCount — pure helper stays deterministic (OOS-1)', () => {
  it('counts non-scene asset entries', () => {
    const { deps } = makeDeps();
    const io = createDiskIo(deps);
    const pack = { assets: [{ kind: 'scene' }, { kind: 'material' }, { kind: 'texture' }] };
    expect(io.inlineAssetCount(pack)).toBe(2);
    expect(io.inlineAssetCount({ assets: [] })).toBe(0);
    expect(io.inlineAssetCount(null)).toBe(0);
  });
});
