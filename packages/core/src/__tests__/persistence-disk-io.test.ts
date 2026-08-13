// persistence-disk-io — M2 (w4) headless fake-deps safety net for the HIGH
// SIDE-EFFECT persistence cluster (disk load / save / scene-load / beacon).
//
// These are exactly the paths #88's real-Play safety net could NOT reach: they
// touch the network (fetch / fetchWithTimeout) and the live engine world, so
// before M2 they had no headless coverage. M2 (D-3) extracts them into a
// `createDiskIo(deps)` factory whose deps make every side effect injectable — so
// this suite drives save / load / loadByGuid / flushPendingSaveBeacon with FAKE
// fetch + fetchWithTimeout + gateway, asserting:
//   - AC-02: the factory reaches all state THROUGH deps (deps.ctx / deps.gateway),
//     never a module-level singleton — a fresh fake ctx fully controls behavior.
//   - AC-02 × R-P1: fetch is a DEP (structural injection), so a headless test
//     injects a fake that never touches the network. This is the injection seam
//     plan-strategy §2 D-2 opens (import→deps), NOT a change to the transport body
//     (OOS-5).
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
//     (high side-effect save/load path regression) ; plan-strategy §2 D-2 (fetch
//     via deps) + §5.3.
//   (backward) covers store/persistence/disk-io.ts, extracted from
//     scene-persistence.ts (itself split from store.ts by historical feat
//     feat-20260705-editor-core-engine-convergence-store-ts-decompose).

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { Name, Transform } from '@forgeax/engine-scene';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  createDiskIo,
  type DiskIoDeps,
  type PersistenceGateway,
  type SaveDocToDiskResult,
} from '../store/persistence/disk-io';
import { assetIO } from '../io/asset-io-facade';
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
    rev: 1,
    replaceDoc(d: EditSession): void { replaceCalls.push(d); },
    dispatch(op: unknown): { ok: true } { dispatchCalls.push(op); return { ok: true }; },
  };
  return { gateway, replaceCalls, dispatchCalls };
}

/** Records fetch / fetchWithTimeout invocations so a test can assert the
 *  factory used the INJECTED seam (not a module import) and how many times. */
function makeNetSpies(opts?: {
  fetchImpl?: (path: string, init?: RequestInit) => Promise<Response>;
  fetchTimeoutImpl?: (url: string) => Promise<Response>;
}) {
  const fetchCalls: Array<{ path: string; init?: RequestInit }> = [];
  const fetchTimeoutCalls: string[] = [];
  const fetchFn = (path: string, init?: RequestInit): Promise<Response> => {
    fetchCalls.push({ path, init });
    return opts?.fetchImpl
      ? opts.fetchImpl(path, init)
      : Promise.reject(new Error('fetch must not be called in this case'));
  };
  const fetchWithTimeout = (url: string): Promise<Response> => {
    fetchTimeoutCalls.push(url);
    return opts?.fetchTimeoutImpl
      ? opts.fetchTimeoutImpl(url)
      : Promise.reject(new Error('fetchWithTimeout must not be called in this case'));
  };
  return { fetch: fetchFn, fetchWithTimeout, fetchCalls, fetchTimeoutCalls };
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
    fetch: net.fetch,
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

describe('instantiateSceneRefUnderWorld — normalized mounts remain saveable', () => {
  it('preserves the loaded scene GUID after animation compatibility normalization', async () => {
    const world = new World();
    const registry = new AssetRegistry({} as never);
    const childGuid = '11111111-1111-4111-8111-111111111111';
    const topGuid = '22222222-2222-4222-8222-222222222222';
    const child = {
      kind: 'scene' as const,
      entities: [
        {
          localId: 0 as never,
          components: { Name: { value: 'bed-mesh' }, Transform: { pos: [0, 0, 0] } },
        },
      ],
    };
    expect(registry.catalog(childGuid, child).ok).toBe(true);

    const wrapper = world.spawn(
      { component: Name, data: { value: 'bed.glb' } },
      { component: Transform, data: { pos: [0, 0, 0] } },
    );
    expect(wrapper.ok).toBe(true);
    if (!wrapper.ok) return;

    const ctx = createScenePersistenceContext();
    ctx.currentSceneId = 'shoot';
    ctx.currentSceneEntities = [wrapper.value];
    const gateway = makeFakeGateway({ world, registry }).gateway;
    const deps: DiskIoDeps = {
      ctx,
      gateway,
      fetch: async () => new Response('{}', { status: 200 }),
      fetchWithTimeout: async () => new Response('{}', { status: 200 }),
      resolveGamePath: (rel) => `/games/g1/${rel}`,
      notifyDocChanged: () => {},
    };
    const io = createDiskIo(deps);

    const mounted = await io.instantiateSceneRefUnderWorld(childGuid, wrapper.value as number);
    expect(mounted).not.toBeNull();

    const serialized = io.worldToPack(gateway.doc, topGuid);
    expect(serialized).not.toBeNull();
    if (serialized === null) return;
    const pack = JSON.parse(serialized) as {
      assets: Array<{
        kind?: string;
        refs?: string[];
        payload?: { mounts?: Array<{ source: number }> };
      }>;
    };
    const sceneEntry = pack.assets.find((asset) => asset.kind === 'scene');
    expect(sceneEntry?.refs).toEqual([childGuid]);
    expect(sceneEntry?.payload?.mounts?.map((mount) => mount.source)).toEqual([0]);
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
  it('refuses imported preview save before serialization or write', async () => {
    const net = makeNetSpies();
    const { deps, ctx } = makeDeps({
      fetch: net.fetch,
      fetchWithTimeout: net.fetchWithTimeout,
      serializeForSave: () => { throw new Error('preview must not serialize'); },
    });
    ctx.currentSceneId = 'shoot';
    ctx.authoringSession = {
      mode: 'imported-preview',
      canMutate: false,
      saveTarget: null,
      reason: 'Imported previews are derived and read-only.',
    };
    ctx.isDirty = true;
    const io = createDiskIo(deps);

    expect(io.scenePath()).toBeNull();
    expect(await io.doSaveDocToDisk()).toMatchObject({
      ok: false,
      error: { code: 'save-rejected-in-imported-preview' },
    });
    io.flushPendingSaveBeacon();
    expect(net.fetchCalls).toHaveLength(0);
    expect(ctx.isDirty).toBe(true);
  });

  it('returns false and NEVER calls fetch when the world is headless (serialize fails)', async () => {
    const net = makeNetSpies();
    const { deps, ctx } = makeDeps({ fetch: net.fetch, fetchWithTimeout: net.fetchWithTimeout });
    ctx.currentSceneId = 'shoot';
    ctx.isDirty = true;
    const io = createDiskIo(deps);
    const result = await io.doSaveDocToDisk({ acceptedRevision: 1 });
    expect(result).toMatchObject({ ok: false, error: { code: 'save-serialization-failed' } });
    // The 0-byte data-loss guard: no write attempted over a good on-disk scene.
    expect(net.fetchCalls.length).toBe(0);
    // Save aborted before clearing dirty → the next save can retry.
    expect(ctx.isDirty).toBe(true);
  });

  it('returns false for the default slug (no scenePath) without any network', async () => {
    const net = makeNetSpies();
    const { deps, ctx } = makeDeps({ fetch: net.fetch, fetchWithTimeout: net.fetchWithTimeout });
    ctx.currentSceneId = 'default';
    const io = createDiskIo(deps);
    const result = await io.doSaveDocToDisk({ acceptedRevision: 1 });
    expect(result).toMatchObject({ ok: false, error: { code: 'save-serialization-failed' } });
    expect(net.fetchCalls.length).toBe(0);
    expect(net.fetchTimeoutCalls.length).toBe(0);
  });
});

describe('worldToPack — preserves tracked scene roots when live root discovery is incomplete', () => {
  it('serializes a loaded root even when it has no Name component', () => {
    const world = new World();
    const spawned = world.spawn({
      component: Transform,
      data: { pos: [1, 2, 3] },
    });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;

    const ctx = createScenePersistenceContext();
    ctx.currentSceneId = 'shoot';
    ctx.currentSceneEntities = [spawned.value];
    const gateway = makeFakeGateway({ world, registry: new AssetRegistry({} as never) }).gateway;
    const deps: DiskIoDeps = {
      ctx,
      gateway,
      fetch: async () => new Response('{}', { status: 200 }),
      fetchWithTimeout: async () => new Response('{}', { status: 200 }),
      resolveGamePath: (rel) => `/games/g1/${rel}`,
      notifyDocChanged: () => {},
    };

    const serialized = createDiskIo(deps).worldToPack(gateway.doc, 'aaaaaaaa-bbbb-4ccc-dddd-000000000001');
    expect(serialized).not.toBeNull();
    const parsed = JSON.parse(serialized!);
    const scene = parsed.assets.find((asset: { kind?: string }) => asset.kind === 'scene');
    expect(scene.payload.entities).toHaveLength(1);
    expect(scene.payload.entities[0].components.Transform.pos).toEqual([1, 2, 3]);
  });
});

// M2-T1: the real save safety boundary must expose structured terminal failures,
// not a boolean or a message copied from console output. Every fixture uses an
// injected serializer so the test reaches the exact guard under test without a
// live WebGPU world. A fake resource store records the old bytes and only changes
// them after a successful canonical commit; all refusal paths must leave them and
// the dirty/self-save facts untouched.
const validPack = (options?: {
  readonly entities?: readonly unknown[];
  readonly inlineAssets?: number;
}): string => JSON.stringify({
  schemaVersion: '1.0.0',
  kind: 'internal-text-package',
  assets: [
    {
      guid: '550e8400-e29b-41d4-a716-446655440000',
      kind: 'scene',
      refs: [],
      payload: { entities: options?.entities ?? [{ localId: 'root' }] },
    },
    ...Array.from({ length: options?.inlineAssets ?? 0 }, (_, index) => ({
      guid: `inline-${index}`,
      kind: 'material',
      refs: [],
      payload: { name: `material-${index}` },
    })),
  ],
});

function saveFixture(options: {
  readonly serialized: string | null;
  readonly ctx?: Partial<ScenePersistenceContext>;
  readonly fetchImpl?: (path: string, init?: RequestInit) => Promise<Response>;
  readonly transaction?: DiskIoDeps['prepareResourceTransaction'];
  readonly serializerThrows?: boolean;
  readonly onSerialize?: (sceneGuid?: string) => void;
}): {
  readonly io: ReturnType<typeof createDiskIo>;
  readonly ctx: ScenePersistenceContext;
  readonly fetchCalls: Array<{ path: string; init?: RequestInit }>;
  readonly bytes: { value: string };
} {
  const bytes = { value: '{"lastGood":true}\n' };
  const fetchCalls: Array<{ path: string; init?: RequestInit }> = [];
  const ctx = Object.assign(createScenePersistenceContext(), {
    currentSceneId: 'shoot',
    isDirty: true,
    ...options.ctx,
  });
  const { gateway } = makeFakeGateway();
  const deps: DiskIoDeps = {
    ctx,
    gateway,
    fetch: async (path, init) => {
      fetchCalls.push({ path, init });
      if (options.fetchImpl) return options.fetchImpl(path, init);
      bytes.value = typeof init?.body === 'string' ? init.body : bytes.value;
      return new Response('{}', { status: 200 });
    },
    fetchWithTimeout: async () => new Response('{}', { status: 200 }),
    resolveGamePath: (rel) => `/games/g1/${rel}`,
    notifyDocChanged: () => {},
    serializeForSave: (_doc, sceneGuid) => {
      options.onSerialize?.(sceneGuid);
      if (options.serializerThrows) throw new Error('serializer fixture exploded');
      return options.serialized;
    },
    prepareResourceTransaction: options.transaction,
  };
  return { io: createDiskIo(deps), ctx, fetchCalls, bytes };
}

function expectSaveFailure(
  result: SaveDocToDiskResult,
  code: string,
  expected: Record<string, unknown>,
): void {
  expect(result).toMatchObject({
    ok: false,
    error: {
      code,
      hint: expect.any(String),
      retryable: expect.any(Boolean),
      recoveryActions: expect.arrayContaining([expect.any(String)]),
      ...expected,
    },
  });
}

describe('M2-T1 structured save failures preserve bytes and dirty state', () => {
  it('reuses the discovered scene GUID when an early save has no loaded GUID yet', async () => {
    let serializedGuid: string | undefined;
    const fixture = saveFixture({
      serialized: validPack(),
      ctx: {
        currentSceneFile: 'scene',
        currentSceneGuid: null,
        sceneList: [{ id: 'scene', pack: 'assets/scene.pack.json', guid: 'authored-scene-guid' }],
      },
      onSerialize: (sceneGuid) => { serializedGuid = sceneGuid; },
    });
    expect(await fixture.io.doSaveDocToDisk()).toMatchObject({ ok: true });
    expect(serializedGuid).toBe('authored-scene-guid');
  });

  it('classifies serializer failure before any write', async () => {
    const fixture = saveFixture({ serialized: null });
    const result = await fixture.io.doSaveDocToDisk({ acceptedRevision: 1 });
    expectSaveFailure(result, 'save-serialization-failed', { subjectRef: { kind: 'scene', id: '/games/g1/scene.pack.json' } });
    expect(fixture.fetchCalls).toHaveLength(0);
    expect(fixture.bytes.value).toBe('{"lastGood":true}\n');
    expect(fixture.ctx.isDirty).toBe(true);
    expect(fixture.ctx.lastSelfSave).toBeNull();
  });

  it('classifies pack-shell validation failure before any write', async () => {
    const fixture = saveFixture({ serialized: JSON.stringify({ schemaVersion: '1.0.0', assets: [] }) });
    const result = await fixture.io.doSaveDocToDisk({ acceptedRevision: 1 });
    expectSaveFailure(result, 'save-pack-validation-failed', { subjectRef: { kind: 'scene', id: '/games/g1/scene.pack.json' } });
    expect(fixture.fetchCalls).toHaveLength(0);
    expect(fixture.bytes.value).toBe('{"lastGood":true}\n');
    expect(fixture.ctx.isDirty).toBe(true);
  });

  it('classifies inline-asset floor loss with expected/current counts', async () => {
    const fixture = saveFixture({ serialized: validPack({ inlineAssets: 1 }), ctx: { loadedInlineAssetFloor: 2 } });
    const result = await fixture.io.doSaveDocToDisk({ acceptedRevision: 1 });
    expectSaveFailure(result, 'save-inline-assets-missing', {
      expected: { minimum: 2 },
      current: { actual: 1 },
      subjectRef: { kind: 'scene', id: '/games/g1/scene.pack.json' },
    });
    expect(fixture.fetchCalls).toHaveLength(0);
    expect(fixture.bytes.value).toBe('{"lastGood":true}\n');
    expect(fixture.ctx.isDirty).toBe(true);
  });

  it('classifies entity floor loss with expected/current counts', async () => {
    const fixture = saveFixture({ serialized: validPack({ entities: [] }), ctx: { loadedEntityFloor: 1 } });
    const result = await fixture.io.doSaveDocToDisk({ acceptedRevision: 1 });
    expectSaveFailure(result, 'save-entities-missing', {
      expected: { minimum: 1 },
      current: { actual: 0 },
      subjectRef: { kind: 'scene', id: '/games/g1/scene.pack.json' },
    });
    expect(fixture.fetchCalls).toHaveLength(0);
    expect(fixture.bytes.value).toBe('{"lastGood":true}\n');
    expect(fixture.ctx.isDirty).toBe(true);
  });

  it('classifies canonical write failure and preserves the previous bytes', async () => {
    const fixture = saveFixture({
      serialized: validPack(),
      fetchImpl: async () => new Response('write failed', { status: 503 }),
    });
    const result = await fixture.io.doSaveDocToDisk({ acceptedRevision: 1 });
    expectSaveFailure(result, 'save-write-failed', { subjectRef: { kind: 'scene', id: '/games/g1/scene.pack.json' } });
    expect(fixture.fetchCalls).toHaveLength(1);
    expect(fixture.bytes.value).toBe('{"lastGood":true}\n');
    expect(fixture.ctx.isDirty).toBe(true);
    expect(fixture.ctx.lastSelfSave).toBeNull();
  });

  it('classifies unexpected effect errors without treating them as writes', async () => {
    const fixture = saveFixture({ serialized: validPack(), serializerThrows: true });
    const result = await fixture.io.doSaveDocToDisk({ acceptedRevision: 1 });
    expectSaveFailure(result, 'save-unexpected-failure', { subjectRef: { kind: 'scene', id: '/games/g1/scene.pack.json' } });
    expect(fixture.fetchCalls).toHaveLength(0);
    expect(fixture.bytes.value).toBe('{"lastGood":true}\n');
    expect(fixture.ctx.isDirty).toBe(true);
  });
});

// Material-persistence fix: the scene save commits through the asset gate's
// per-path write chain, so a createMaterial read-modify-write on the SAME scene
// pack can never interleave with the save's write. The floor is re-checked
// INSIDE the chain: if a material write landed while the save waited (raising
// the baseline), the pre-computed body is refused instead of clobbering it.
describe('doSaveDocToDisk — pack write chain + in-chain floor re-check', () => {
  it('waits behind an in-flight pack write, then refuses when the floor rose during the wait', async () => {
    const fixture = saveFixture({ serialized: validPack({ inlineAssets: 1 }), ctx: { loadedInlineAssetFloor: 1 } });
    const packPath = '/games/g1/scene.pack.json';

    // Occupy the gate's chain for the scene pack (stands in for an in-flight
    // createMaterial read-modify-write).
    let release!: () => void;
    const holder = assetIO.runExclusivePackWrite(packPath, () => new Promise<void>((resolve) => { release = resolve; }));

    const savePromise = fixture.io.doSaveDocToDisk({ acceptedRevision: 1 });
    // Let the save serialize + queue behind the held chain link.
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The material write landed while the save waited: the baseline rose.
    fixture.ctx.loadedInlineAssetFloor = 2;
    release();

    const result = await savePromise;
    await holder;
    expectSaveFailure(result, 'save-inline-assets-missing', {
      expected: { minimum: 2 },
      current: { actual: 1 },
      subjectRef: { kind: 'scene', id: packPath },
    });
    expect(fixture.fetchCalls).toHaveLength(0);
    expect(fixture.bytes.value).toBe('{"lastGood":true}\n');
    expect(fixture.ctx.isDirty).toBe(true);
  });

  it('commits after the held write releases when the floor is still satisfied', async () => {
    const fixture = saveFixture({ serialized: validPack({ inlineAssets: 1 }), ctx: { loadedInlineAssetFloor: 1 } });
    const packPath = '/games/g1/scene.pack.json';

    const order: string[] = [];
    let release!: () => void;
    const holder = assetIO.runExclusivePackWrite(packPath, async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      order.push('gated-write');
    });

    const savePromise = fixture.io.doSaveDocToDisk({ acceptedRevision: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The save is queued behind the holder — nothing written yet.
    expect(fixture.fetchCalls).toHaveLength(0);
    release();

    const result = await savePromise;
    await holder;
    expect(result).toMatchObject({ ok: true });
    expect(order).toEqual(['gated-write']);
    expect(fixture.fetchCalls).toHaveLength(1);
  });
});

describe('doLoadDocFromDisk — uses the injected fetchWithTimeout, publishes guid only after load (AC-02)', () => {
  it('returns false for the default slug without touching the injected net', async () => {
    const net = makeNetSpies();
    const { deps, ctx } = makeDeps({ fetch: net.fetch, fetchWithTimeout: net.fetchWithTimeout });
    ctx.currentSceneId = 'default';
    const io = createDiskIo(deps);
    expect(await io.doLoadDocFromDisk()).toBe(false);
    expect(net.fetchTimeoutCalls.length).toBe(0);
  });

  it('reads THIS scene path through the injected fetchWithTimeout without publishing a failed load guid', async () => {
    // A valid pack with a scene asset GUID; the load then reaches loadSceneByGuid
    // which returns false headlessly (null world) — so the doc and current GUID
    // must not change, even though the read went through the injected seam.
    const guid = '11111111-2222-5333-8444-555555555555';
    const packJson = JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'internal-text-package',
      assets: [{ guid, kind: 'scene', payload: { entities: [] }, refs: [] }],
    });
    const net = makeNetSpies({
      fetchTimeoutImpl: () => Promise.resolve(new Response(JSON.stringify({ content: packJson }), { status: 200 })),
    });
    const { deps, ctx } = makeDeps({ fetch: net.fetch, fetchWithTimeout: net.fetchWithTimeout });
    ctx.currentSceneId = 'shoot';
    const io = createDiskIo(deps);
    const ok = await io.doLoadDocFromDisk();
    expect(ok).toBe(false); // loadSceneByGuid fails on the headless (null) world
    expect(net.fetchTimeoutCalls.length).toBe(1);
    expect(net.fetchTimeoutCalls[0]).toContain(encodeURIComponent('/games/g1/scene.pack.json'));
    // A failed engine load must not publish a GUID for a scene that is not live.
    expect(ctx.currentSceneGuid).toBeNull();
  });
});

describe('doLoadDocFromDisk — legacy material refs migration', () => {
  it('persists refs/index repairs and invalidates ready registry payloads before refresh load', async () => {
    const sceneGuid = '11111111-2222-5333-8444-555555555555';
    const materialGuid = 'aaaaaaaa-bbbb-4ccc-dddd-000000000001';
    const textureGuid = '019fc6c4-b507-7a87-a87c-a803faf8baa7';
    const pack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: sceneGuid,
          kind: 'scene',
          payload: { entities: [] },
          refs: [materialGuid],
        },
        {
          guid: materialGuid,
          kind: 'material',
          payload: {
            kind: 'material',
            values: {
              metallic: textureGuid,
              baseColorTexture: textureGuid,
            },
          },
          refs: [],
        },
      ],
    };
    const invalidated: string[] = [];
    const registry = {
      assetCatalog: new Map(),
      async loadByGuid() {
        return { ok: true, value: { kind: 'scene', entities: [] } };
      },
      catalog(_guid: string, payload: unknown) {
        return { ok: true, value: payload };
      },
      invalidate(guid: string) {
        invalidated.push(guid);
      },
      instantiateFlat() {
        return { ok: true, value: [] };
      },
    } as never;
    const ctx = createScenePersistenceContext();
    ctx.currentSceneId = 'shoot';
    const net = makeNetSpies({
      fetchTimeoutImpl: () => Promise.resolve(new Response(JSON.stringify({ content: JSON.stringify(pack) }), { status: 200 })),
    });
    const world = new World();
    const gateway = makeFakeGateway({ world, registry }).gateway;
    const { deps } = makeDeps({
      ctx,
      gateway,
      fetch: net.fetch,
      fetchWithTimeout: net.fetchWithTimeout,
      resolveGamePath: () => '/games/g1/scene.pack.json',
    });
    const originalWritePackEntry = assetIO.writePackEntry;
    const migratedEntries: unknown[] = [];
    assetIO.writePackEntry = (async (_packPath: string, entry) => {
      migratedEntries.push(entry);
      return true;
    }) as typeof assetIO.writePackEntry;

    try {
      expect(await createDiskIo(deps).doLoadDocFromDisk()).toBe(true);
    } finally {
      assetIO.writePackEntry = originalWritePackEntry;
    }

    const material = migratedEntries.find(
      (entry) => (entry as { guid?: string }).guid === materialGuid,
    ) as { refs: string[]; payload: { values?: Record<string, unknown> } } | undefined;
    expect(material?.refs).toEqual([textureGuid]);
    expect(material?.payload.values).toMatchObject({ metallic: 0, baseColorTexture: 0 });
    expect(invalidated).toEqual([materialGuid, sceneGuid]);
    expect(ctx.loadedInlineAssets?.[0]?.refs).toEqual([textureGuid]);
  });
});

describe('loadSceneByGuid — headless world short-circuits (AC-02)', () => {
  it('returns false when gateway.doc has no world/registry', async () => {
    const { deps } = makeDeps();
    const io = createDiskIo(deps);
    expect(await io.loadSceneByGuid('11111111-2222-5333-8444-555555555555')).toBe(false);
  });

  it('surfaces thrown asset-load failures with the scene GUID', async () => {
    const warnings: string[] = [];
    const previousWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      const { deps } = makeDeps({
        gateway: makeFakeGateway({
          world: {} as never,
          registry: { loadByGuid: async () => { throw new Error('pack body unavailable'); } } as never,
        }).gateway,
      });
      const guid = '11111111-2222-5333-8444-555555555555';
      expect(await createDiskIo(deps).loadSceneByGuid(guid)).toBe(false);
      expect(warnings.join('\n')).toContain(guid);
      expect(warnings.join('\n')).toContain('pack body unavailable');
    } finally {
      console.warn = previousWarn;
    }
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
