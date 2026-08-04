// w9 (feat-20260705 M3 / plan-strategy §D-4/S-3): drag-spawn-resolve bridge
// pure-logic test. RED before w11 creates the bridge module.
//
// The bridge (installDragSpawnMeshResolver) subscribes to the EditGateway and,
// for each spawnEntity command carrying an EditorPendingMeshAsset marker,
// resolves the real asset guid to a mesh handle and patches
// MeshFilter.assetHandle over the bus (plan-strategy §D-4 — the bus is the only
// legal mutable path: ledger audit + subscriber repaint).
//
// This test injects stub bus/world/renderer so it exercises the bridge's
// command-filter + resolve orchestration WITHOUT a real engine World:
//   (a) non-spawnEntity command      -> zero action
//   (b) spawnEntity without marker    -> zero action
//   (c) spawnEntity WITH marker       -> loadByGuid(guid) called
//   (d) loadByGuid ok                 -> allocSharedRef('MeshAsset', payload) +
//                                        bus.dispatch(setComponent MeshFilter{handle}, 'ai')
//   (e) loadByGuid fail               -> failedGuid recorded + ONE console.error, no retry
//   (f) same guid twice (redo replay) -> idempotent, no duplicate error storm
//
// Anchors:
//   plan-tasks.json w9: command filter + resolve orchestration RED
//   plan-strategy §D-4 (dispatch over bus), §S-3 (redo idempotency + failedGuid)
//   research Finding 4(b)(d): loadByGuid -> allocSharedRef -> setComponent chain

import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { EditorOp } from '@forgeax/editor-core';
import { registerPostAssetWriteCatalogSync, recentAssetsErrors } from '@forgeax/editor-core';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { installDragSpawnMeshResolver } from '../viewport/drag-spawn-resolve';

// A syntactically valid RFC 4122 dash-form UUID (AssetGuid.parse accepts it).
const GOOD_GUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface DispatchedCmd { cmd: EditorOp; origin?: string }

/** Minimal bus stub: captures the subscribed listener + dispatched commands.
 *  `failDispatch[kind]` makes that op's dispatch return a structured rejection;
 *  `runResult` controls what waitOperationRun resolves (default: succeeded). */
function makeBusStub(
  catalogRows: unknown[] = [],
  extra: {
    failDispatch?: Record<string, { code: string; hint: string }>;
    runResult?: { ok: true; value: { status: string; error?: { hint: string } } } | { ok: false; error: { hint: string } };
  } = {},
) {
  let listener: ((doc: unknown, lastCommand: EditorOp | null) => void) | null = null;
  const dispatched: DispatchedCmd[] = [];
  return {
    subscribe(fn: (doc: unknown, lastCommand: EditorOp | null) => void) {
      listener = fn;
      return () => { listener = null; };
    },
    dispatch(cmd: EditorOp, origin?: string) {
      dispatched.push({ cmd, origin });
      const fail = extra.failDispatch?.[cmd.kind as string];
      if (fail) return { ok: false as const, error: fail };
      return { ok: true as const };
    },
    assetCatalog() {
      return catalogRows;
    },
    waitOperationRun(_requestId: string) {
      return Promise.resolve(extra.runResult ?? { ok: true as const, value: { status: 'succeeded' } });
    },
    /** Test-only: fire the captured listener with a synthetic lastCommand. */
    fire(lastCommand: EditorOp | null) {
      listener?.({}, lastCommand);
    },
    dispatched,
  };
}

function makeWorldStub(handle = 42) {
  const allocSharedRef = mock((_brand: string, _payload: unknown) => handle);
  return { allocSharedRef };
}

function makeRendererStub(result: { ok: boolean; value?: unknown; error?: { code?: string } }) {
  const loadByGuid = mock(async (_guid: unknown) => result);
  return { assets: { loadByGuid } };
}

function spawnCmd(opts: { withMarker?: boolean; guid?: string; id?: number } = {}): EditorOp {
  const components: Record<string, unknown> = { MeshFilter: { assetHandle: 0 } };
  if (opts.withMarker) components.EditorPendingMeshAsset = { guid: opts.guid ?? GOOD_GUID };
  return { kind: 'spawnEntity', name: 'Chair', components, _id: opts.id ?? 7 };
}

let errSpy: ReturnType<typeof mock> | null = null;
afterEach(() => { if (errSpy) { console.error = originalError; errSpy = null; } });
const originalError = console.error;
function spyOnError() {
  errSpy = mock((..._args: unknown[]) => {});
  console.error = errSpy as unknown as typeof console.error;
  return errSpy;
}

describe('w9 installDragSpawnMeshResolver bridge (RED before w11)', () => {
  it('(a) non-spawnEntity command -> zero action', async () => {
    const bus = makeBusStub();
    const world = makeWorldStub();
    const renderer = makeRendererStub({ ok: true, value: {} });
    installDragSpawnMeshResolver(bus as never, world as never, renderer as never);
    bus.fire({ kind: 'setComponent', entity: 1, component: 'Transform', patch: {} });
    await flush();
    expect(renderer.assets.loadByGuid).not.toHaveBeenCalled();
    expect(bus.dispatched.length).toBe(0);
  });

  it('(b) spawnEntity without marker -> zero action', async () => {
    const bus = makeBusStub();
    const world = makeWorldStub();
    const renderer = makeRendererStub({ ok: true, value: {} });
    installDragSpawnMeshResolver(bus as never, world as never, renderer as never);
    bus.fire(spawnCmd({ withMarker: false }));
    await flush();
    expect(renderer.assets.loadByGuid).not.toHaveBeenCalled();
    expect(bus.dispatched.length).toBe(0);
  });

  it('(c)+(d) spawnEntity with marker -> loadByGuid + allocSharedRef + bus setComponent(ai)', async () => {
    const bus = makeBusStub();
    const world = makeWorldStub(99);
    const meshPayload = { verts: 3 };
    const renderer = makeRendererStub({ ok: true, value: meshPayload });
    installDragSpawnMeshResolver(bus as never, world as never, renderer as never);
    bus.fire(spawnCmd({ withMarker: true, id: 7 }));
    await flush();

    expect(renderer.assets.loadByGuid).toHaveBeenCalledTimes(1);
    expect(world.allocSharedRef).toHaveBeenCalledTimes(1);
    expect(world.allocSharedRef.mock.calls[0]?.[0]).toBe('MeshAsset');
    expect(world.allocSharedRef.mock.calls[0]?.[1]).toBe(meshPayload);

    expect(bus.dispatched.length).toBe(1);
    const { cmd, origin } = bus.dispatched[0]!;
    expect(origin).toBe('ai');
    expect(cmd.kind).toBe('setComponent');
    const sc = cmd as Extract<EditorOp, { kind: 'setComponent' }>;
    expect(sc.entity).toBe(7);
    expect(sc.component).toBe('MeshFilter');
    expect(sc.patch.assetHandle).toBe(99);
  });

  it('(e) loadByGuid failure -> one console.error, no dispatch, no throw', async () => {
    const spy = spyOnError();
    const bus = makeBusStub();
    const world = makeWorldStub();
    const renderer = makeRendererStub({ ok: false, error: { code: 'load-miss' } });
    installDragSpawnMeshResolver(bus as never, world as never, renderer as never);
    bus.fire(spawnCmd({ withMarker: true }));
    await flush();

    expect(world.allocSharedRef).not.toHaveBeenCalled();
    expect(bus.dispatched.length).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('(f) same guid twice (redo replay) -> idempotent, failedGuid suppresses second error', async () => {
    const spy = spyOnError();
    const bus = makeBusStub();
    const world = makeWorldStub();
    const renderer = makeRendererStub({ ok: false, error: { code: 'load-miss' } });
    installDragSpawnMeshResolver(bus as never, world as never, renderer as never);

    bus.fire(spawnCmd({ withMarker: true, guid: GOOD_GUID }));
    await flush();
    bus.fire(spawnCmd({ withMarker: true, guid: GOOD_GUID }));
    await flush();

    // Second replay must NOT re-attempt the load (failedGuid guard) and must NOT
    // fire a second console.error (no retry storm).
    expect(renderer.assets.loadByGuid).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ── w2 (feat-20260708 M1): the MATERIAL resolve branch ───────────────────────
//
// plan-strategy D-2/D-3/D-5 · requirements AC-02/AC-03 · research Finding A2.
//
// The core mesh spawn command now also carries a command-level
// `EditorPendingMeshMaterials{guids}` marker (w3). The bridge grows a PARALLEL
// material branch (w7, same subscribe callback) that mirrors the mesh branch:
//   AssetGuid.parse(guid) -> renderer.assets.loadByGuid ->
//   engine.allocSharedRef('MaterialAsset', payload) ->
//   bus.dispatch(setComponent MeshRenderer{materials:[handles]}, 'ai')
//
// THREE contract points this RED suite pins (all fail until w7 lands the branch):
//   (m1) COUNT ALIGN — the dispatched MeshRenderer.materials.length MUST equal
//        guids.length. A '' slot (a primitive with no source glTF material) is
//        filled with the first resolved material handle (bridge firstMatHandle
//        convention, D-3) — NOT dropped, or engine fail-fast
//        `mesh-renderer-material-count-mismatch` skips the entity.
//   (m2) FAILURE DISCIPLINE — a bad guid / load miss records the guid in `failed`
//        and emits ONE structured console.error({guid, code, hint}); a second
//        replay of the same guid is short-circuited (no retry storm, D-5).
//   (m3) NORMAL PATCH — every non-'' guid resolves through
//        allocSharedRef('MaterialAsset', payload) and the whole handle array is
//        patched onto MeshRenderer via one setComponent('ai').

// A material guid stub table keyed by dash-form uuid -> payload the renderer
// returns for loadByGuid. Missing keys resolve as a load miss.
const MAT_GUID_A = 'b1111111-1111-4111-8111-111111111111';
const MAT_GUID_B = 'b2222222-2222-4222-8222-222222222222';
const MAT_GUID_BAD = 'not-a-uuid';

/** Renderer stub that returns a per-guid payload (miss = ok:false). */
function makeMaterialRendererStub(table: Record<string, unknown>) {
  const loadByGuid = mock(async (guid: unknown) => {
    // guid is an AssetGuid (Uint8Array) — recover its dash-form for the table.
    const key = AssetGuid.format(guid as never);
    if (key in table) return { ok: true as const, value: table[key] };
    return { ok: false as const, error: { code: 'load-miss' } };
  });
  return { assets: { loadByGuid } };
}

/** World stub minting a distinct handle per allocSharedRef call. */
function makeMaterialWorldStub() {
  let next = 100;
  const allocSharedRef = mock((_brand: string, _payload: unknown) => next++);
  return { allocSharedRef };
}

// Material-branch isolation: no EditorPendingMeshAsset marker here, so the mesh
// branch is a no-op and only the material branch acts (its load-miss errors do
// not pollute these material-branch assertions). Co-presence of both markers is
// the realistic case but the two branches read independent marker keys — the mesh
// branch is already covered by the w9 suite above.
function matSpawnCmd(opts: { guids?: string[]; id?: number } = {}): EditorOp {
  const components: Record<string, unknown> = { MeshFilter: { assetHandle: 0 } };
  if (opts.guids) components.EditorPendingMeshMaterials = { guids: opts.guids };
  return { kind: 'spawnEntity', name: 'Chair', components, _id: opts.id ?? 7 };
}

/** Pull the MeshRenderer setComponent from the dispatched-command log, or null. */
function meshRendererPatch(dispatched: DispatchedCmd[]): { handles: number[]; origin?: string } | null {
  const hit = dispatched.find(
    (d) => d.cmd.kind === 'setComponent' && (d.cmd as { component?: string }).component === 'MeshRenderer',
  );
  if (!hit) return null;
  const sc = hit.cmd as Extract<EditorOp, { kind: 'setComponent' }>;
  return { handles: (sc.patch as { materials?: number[] }).materials ?? [], origin: hit.origin };
}

describe('w2 material resolve branch (RED before w7)', () => {
  it('(m3) normal: every non-empty guid -> allocSharedRef(MaterialAsset) + one setComponent(MeshRenderer, ai)', async () => {
    const bus = makeBusStub();
    const world = makeMaterialWorldStub();
    const renderer = makeMaterialRendererStub({ [MAT_GUID_A]: { m: 'A' }, [MAT_GUID_B]: { m: 'B' } });
    installDragSpawnMeshResolver(bus as never, world as never, renderer as never);
    bus.fire(matSpawnCmd({ guids: [MAT_GUID_A, MAT_GUID_B], id: 7 }));
    await flush();

    // Two material allocs, each branded 'MaterialAsset' (NOT 'MeshAsset').
    const matCalls = world.allocSharedRef.mock.calls.filter((c) => c[0] === 'MaterialAsset');
    expect(matCalls.length).toBe(2);
    expect(matCalls[0]?.[1]).toEqual({ m: 'A' });
    expect(matCalls[1]?.[1]).toEqual({ m: 'B' });

    const patch = meshRendererPatch(bus.dispatched);
    expect(patch).not.toBeNull();
    expect(patch!.origin).toBe('ai');
    expect(patch!.handles.length).toBe(2); // count align: == guids.length
  });

  it('(m1) count align: a "" slot is filled with the first resolved handle, length == guids.length', async () => {
    const bus = makeBusStub();
    const world = makeMaterialWorldStub();
    const renderer = makeMaterialRendererStub({ [MAT_GUID_A]: { m: 'A' }, [MAT_GUID_B]: { m: 'B' } });
    installDragSpawnMeshResolver(bus as never, world as never, renderer as never);
    // 3 submeshes: matA, (gap), matB -> handles [A, firstMat=A, B], never length 2.
    bus.fire(matSpawnCmd({ guids: [MAT_GUID_A, '', MAT_GUID_B], id: 7 }));
    await flush();

    const patch = meshRendererPatch(bus.dispatched);
    expect(patch).not.toBeNull();
    expect(patch!.handles.length).toBe(3); // NOT 2 — the '' slot is filled, not dropped
    // The '' slot borrows the first resolved handle (bridge firstMatHandle, D-3).
    expect(patch!.handles[1]).toBe(patch!.handles[0]);
  });

  it('(m2) failure discipline: a bad guid emits ONE structured console.error, no retry storm', async () => {
    const spy = spyOnError();
    const bus = makeBusStub();
    const world = makeMaterialWorldStub();
    const renderer = makeMaterialRendererStub({ [MAT_GUID_A]: { m: 'A' } });
    installDragSpawnMeshResolver(bus as never, world as never, renderer as never);

    // Same bad-guid marker fired twice (redo replay).
    bus.fire(matSpawnCmd({ guids: [MAT_GUID_BAD], id: 7 }));
    await flush();
    bus.fire(matSpawnCmd({ guids: [MAT_GUID_BAD], id: 8 }));
    await flush();

    // Exactly one structured error for the bad guid across both replays.
    const matErrors = spy.mock.calls.filter((c) => {
      const payload = c[1] as { guid?: string; code?: string; hint?: string } | undefined;
      return payload?.code === 'bad-guid' && payload?.guid === MAT_GUID_BAD;
    });
    expect(matErrors.length).toBe(1);
    expect((matErrors[0]?.[1] as { hint?: string })?.hint).toBeDefined();
  });

  it('(m2b) load miss: guid parses but loadByGuid misses -> one structured error, count stays aligned via firstMat', async () => {
    const spy = spyOnError();
    const bus = makeBusStub();
    const world = makeMaterialWorldStub();
    // MAT_GUID_A resolves, MAT_GUID_B misses.
    const renderer = makeMaterialRendererStub({ [MAT_GUID_A]: { m: 'A' } });
    installDragSpawnMeshResolver(bus as never, world as never, renderer as never);
    bus.fire(matSpawnCmd({ guids: [MAT_GUID_A, MAT_GUID_B], id: 7 }));
    await flush();

    // One load-miss error for B.
    const missErrors = spy.mock.calls.filter((c) => (c[1] as { code?: string } | undefined)?.code === 'load-miss');
    expect(missErrors.length).toBe(1);

    // Count still aligned: the missed slot falls back to the first resolved handle.
    const patch = meshRendererPatch(bus.dispatched);
    expect(patch).not.toBeNull();
    expect(patch!.handles.length).toBe(2);
    expect(patch!.handles[1]).toBe(patch!.handles[0]);
  });

  it('(m4) no material marker -> no MeshRenderer patch (mesh branch still runs independently)', async () => {
    const bus = makeBusStub();
    const world = makeMaterialWorldStub();
    const renderer = makeMaterialRendererStub({});
    installDragSpawnMeshResolver(bus as never, world as never, renderer as never);
    bus.fire(matSpawnCmd({ id: 7 })); // no guids
    await flush();
    expect(meshRendererPatch(bus.dispatched)).toBeNull();
  });
});

// ── texture resolve branch (UE-style drop) ──────────────────────────────────
//
// A texture drag emits EditorPendingTextureAsset{guid,name}. The resolver:
//   0. LOADS the texture once (aspect dims + alpha facts). A LOAD MISS is
//      terminal: the whole resolve aborts with a broadcastAssetsError toast —
//      a material referencing an unloadable texture can never render (t5).
//   1. DEDUPs against bus.assetCatalog() — a material already referencing the
//      texture GUID is rebound, never duplicated.
//   2. Otherwise dispatches createMaterial (M_<name>, baseColorTexture, and
//      alphaCutoff ONLY when a raw-RGBA pixel scan finds non-opaque alpha).
//      A synchronous rejection surfaces via broadcastAssetsError (t11).
//   3. Awaits the host catalog-visibility barrier, THEN dispatches
//      bindAssetRef — dispatching immediately raced createMaterial's
//      fire-and-forget pack write (loadByGuid missed → entity stuck on the
//      default gray material forever). Ordering is pinned by (t7). A terminal
//      bind-run failure surfaces via broadcastAssetsError (t12).

const TEX_GUID = 'c3333333-3333-4333-8333-333333333333';

function texSpawnCmd(opts: { guid?: string; name?: string | null; id?: number } = {}): EditorOp {
  const marker: Record<string, unknown> = { guid: opts.guid ?? TEX_GUID };
  if (opts.name !== null) marker.name = opts.name ?? 'Wood';
  return {
    kind: 'spawnEntity',
    name: 'Wood',
    components: {
      Transform: { pos: [0, 1, 0], quat: [0, 0, 0, 1], scale: [2, 2, 1] },
      MeshFilter: { assetHandle: 3 },
      EditorPendingTextureAsset: marker,
    },
    _id: opts.id ?? 7,
  };
}

/** RGBA8 texture POD stub; `alpha` fills every alpha byte (255 = opaque). */
function rgbaTexture(w: number, h: number, alpha: number) {
  const data = new Uint8Array(w * h * 4);
  for (let a = 3; a < data.length; a += 4) data[a] = alpha;
  return { kind: 'texture', width: w, height: h, format: 'rgba8unorm', data };
}

function createMaterialCmd(dispatched: DispatchedCmd[]) {
  const hit = dispatched.find((d) => d.cmd.kind === 'createMaterial');
  return hit ? (hit.cmd as Record<string, unknown>) : null;
}

function bindCmd(dispatched: DispatchedCmd[]) {
  const hit = dispatched.find((d) => d.cmd.kind === 'bindAssetRef');
  return hit ? (hit.cmd as Record<string, unknown>) : null;
}

function transformPatchCmd(dispatched: DispatchedCmd[]) {
  const hit = dispatched.find((d) =>
    d.cmd.kind === 'setComponent' && (d.cmd as { component?: string }).component === 'Transform');
  return hit ? (hit.cmd as Record<string, unknown>) : null;
}

describe('texture resolve branch (UE-style drop)', () => {
  it('(t1) fresh drop: createMaterial(M_Wood, baseColorTexture, opaque → no alphaCutoff) + bindAssetRef', async () => {
    const bus = makeBusStub();
    const world = makeMaterialWorldStub();
    const renderer = makeMaterialRendererStub({ [TEX_GUID]: rgbaTexture(4, 4, 255) });
    installDragSpawnMeshResolver(bus as never, world as never, renderer as never);
    bus.fire(texSpawnCmd({ id: 7 }));
    await flush();

    const cm = createMaterialCmd(bus.dispatched);
    expect(cm).not.toBeNull();
    expect(cm!.name).toBe('M_Wood');
    expect(cm!.baseColorTexture).toBe(TEX_GUID);
    expect(cm!.alphaCutoff).toBeUndefined();

    const bind = bindCmd(bus.dispatched);
    expect(bind).not.toBeNull();
    expect(bind!.entity).toBe(7);
    expect(bind!.guids).toEqual([cm!.guid]);
  });

  it('(t2) alpha scan: any alpha<255 pixel → createMaterial carries alphaCutoff 0.5', async () => {
    const bus = makeBusStub();
    const world = makeMaterialWorldStub();
    const renderer = makeMaterialRendererStub({ [TEX_GUID]: rgbaTexture(4, 4, 128) });
    installDragSpawnMeshResolver(bus as never, world as never, renderer as never);
    bus.fire(texSpawnCmd({ id: 7 }));
    await flush();

    expect(createMaterialCmd(bus.dispatched)!.alphaCutoff).toBe(0.5);
  });

  it('(t3) undecidable payload (non-RGBA8 / compressed) → opaque, no alphaCutoff', async () => {
    const bus = makeBusStub();
    const world = makeMaterialWorldStub();
    const renderer = makeMaterialRendererStub({
      [TEX_GUID]: { kind: 'texture', width: 4, height: 4, format: 'bc1-rgba-unorm', data: new Uint8Array(8) },
    });
    installDragSpawnMeshResolver(bus as never, world as never, renderer as never);
    bus.fire(texSpawnCmd({ id: 7 }));
    await flush();

    const cm = createMaterialCmd(bus.dispatched);
    expect(cm).not.toBeNull();
    expect(cm!.alphaCutoff).toBeUndefined();
  });

  it('(t4) dedup: catalog material already refs the texture → bind existing, no createMaterial', async () => {
    const bus = makeBusStub([
      { guid: 'd4444444-4444-4444-8444-444444444444', kind: 'material', refs: [TEX_GUID] },
    ]);
    const world = makeMaterialWorldStub();
    // A dedup-eligible texture IS catalogued, hence loadable — square dims so
    // the aspect patch stays a no-op.
    const renderer = makeMaterialRendererStub({ [TEX_GUID]: rgbaTexture(1024, 1024, 255) });
    installDragSpawnMeshResolver(bus as never, world as never, renderer as never);
    bus.fire(texSpawnCmd({ id: 7 }));
    await flush();

    expect(createMaterialCmd(bus.dispatched)).toBeNull();
    const bind = bindCmd(bus.dispatched);
    expect(bind).not.toBeNull();
    expect(bind!.guids).toEqual(['d4444444-4444-4444-8444-444444444444']);
    // The aspect-facts load still runs on the dedup path (the card scale needs
    // the decoded dims even when the material is reused).
    expect(renderer.assets.loadByGuid).toHaveBeenCalledTimes(1);
    expect(transformPatchCmd(bus.dispatched)).toBeNull();
  });

  it('(t5) texture load miss → ABORTS with a user-visible error (no orphan material, no bind)', async () => {
    const bus = makeBusStub();
    const world = makeMaterialWorldStub();
    const renderer = makeMaterialRendererStub({}); // every guid misses
    installDragSpawnMeshResolver(bus as never, world as never, renderer as never);
    const errorsBefore = recentAssetsErrors().length;
    bus.fire(texSpawnCmd({ id: 7 }));
    await flush();

    // Fail Fast: no material is authored for an unloadable texture (it could
    // never resolve at render — the gray-quad failure), and nothing is bound.
    expect(createMaterialCmd(bus.dispatched)).toBeNull();
    expect(bindCmd(bus.dispatched)).toBeNull();
    // No dims → no aspect patch (the square spawn scale stands).
    expect(transformPatchCmd(bus.dispatched)).toBeNull();
    // The failure is user-visible (panel toast), not console-only.
    const errs = recentAssetsErrors().slice(errorsBefore);
    expect(errs.some((e) => e.op === 'placeAsset' && e.hint.includes('Wood') && e.hint.includes('could not be loaded'))).toBe(true);
  });

  it('(t6) marker without name → material falls back to guid-derived name', async () => {
    const bus = makeBusStub();
    const world = makeMaterialWorldStub();
    const renderer = makeMaterialRendererStub({ [TEX_GUID]: rgbaTexture(4, 4, 255) });
    installDragSpawnMeshResolver(bus as never, world as never, renderer as never);
    bus.fire(texSpawnCmd({ id: 7, name: null }));
    await flush();

    expect(createMaterialCmd(bus.dispatched)!.name).toBe(`M_${TEX_GUID.slice(0, 8)}`);
  });

  it('(t7) RACE REGRESSION: bindAssetRef is dispatched only AFTER the catalog-visibility barrier resolves', async () => {
    const order: string[] = [];
    let releaseBarrier!: () => void;
    registerPostAssetWriteCatalogSync(
      () => new Promise<void>((resolve) => { releaseBarrier = () => { order.push('barrier'); resolve(); }; }),
    );
    try {
      const bus = makeBusStub();
      const world = makeMaterialWorldStub();
      const renderer = makeMaterialRendererStub({ [TEX_GUID]: rgbaTexture(4, 4, 255) });
      installDragSpawnMeshResolver(bus as never, world as never, renderer as never);
      bus.fire(texSpawnCmd({ id: 7 }));
      await flush();

      // Barrier still pending: createMaterial landed, but NO bind yet.
      expect(createMaterialCmd(bus.dispatched)).not.toBeNull();
      expect(bindCmd(bus.dispatched)).toBeNull();

      releaseBarrier();
      await flush();
      const bind = bindCmd(bus.dispatched);
      expect(bind).not.toBeNull();
      expect(order).toEqual(['barrier']);
    } finally {
      registerPostAssetWriteCatalogSync(null);
    }
  });

  it('(t8) ASPECT REGRESSION: wide texture (2048x512) patches Transform to [2, 0.5, 1] with pos.y = 0.26', async () => {
    const bus = makeBusStub();
    const world = makeMaterialWorldStub();
    const renderer = makeMaterialRendererStub({ [TEX_GUID]: rgbaTexture(2048, 512, 255) });
    installDragSpawnMeshResolver(bus as never, world as never, renderer as never);
    bus.fire(texSpawnCmd({ id: 7 })); // spawn scale [2,2,1] (dev rows omit dims)
    await flush();

    const patch = transformPatchCmd(bus.dispatched);
    expect(patch).not.toBeNull();
    expect(patch!.entity).toBe(7);
    const p = patch!.patch as { pos: number[]; scale: number[] };
    expect(p.scale).toEqual([2, 0.5, 1]);
    expect(p.pos[0]).toBe(0);
    expect(p.pos[1]).toBeCloseTo(0.26, 6);
    expect(p.pos[2]).toBe(0);
    // Aspect patch lands BEFORE the material ops (geometry correct first).
    const kinds = bus.dispatched.map((d) => d.cmd.kind);
    expect(kinds.indexOf('setComponent')).toBeLessThan(kinds.indexOf('createMaterial'));
  });

  it('(t9) tall texture (512x2048) patches Transform to [0.5, 2, 1] with pos.y = 1.01', async () => {
    const bus = makeBusStub();
    const world = makeMaterialWorldStub();
    const renderer = makeMaterialRendererStub({ [TEX_GUID]: rgbaTexture(512, 2048, 255) });
    installDragSpawnMeshResolver(bus as never, world as never, renderer as never);
    bus.fire(texSpawnCmd({ id: 7 }));
    await flush();

    const patch = transformPatchCmd(bus.dispatched);
    expect(patch).not.toBeNull();
    const p = patch!.patch as { pos: number[]; scale: number[] };
    expect(p.scale).toEqual([0.5, 2, 1]);
    expect(p.pos[1]).toBeCloseTo(1.01, 6);
  });

  it('(t10) square texture matching the spawn scale → no Transform patch (no ledger noise)', async () => {
    const bus = makeBusStub();
    const world = makeMaterialWorldStub();
    const renderer = makeMaterialRendererStub({ [TEX_GUID]: rgbaTexture(1024, 1024, 255) });
    installDragSpawnMeshResolver(bus as never, world as never, renderer as never);
    bus.fire(texSpawnCmd({ id: 7 }));
    await flush();

    expect(transformPatchCmd(bus.dispatched)).toBeNull();
    expect(createMaterialCmd(bus.dispatched)).not.toBeNull();
  });

  it('(t11) createMaterial rejected → user-visible error, no bind attempted', async () => {
    const bus = makeBusStub([], {
      failDispatch: { createMaterial: { code: 'INVALID_ARGS', hint: 'baseColorTexture is not in the live asset catalog' } },
    });
    const world = makeMaterialWorldStub();
    const renderer = makeMaterialRendererStub({ [TEX_GUID]: rgbaTexture(4, 4, 255) });
    installDragSpawnMeshResolver(bus as never, world as never, renderer as never);
    const errorsBefore = recentAssetsErrors().length;
    bus.fire(texSpawnCmd({ id: 7 }));
    await flush();

    expect(createMaterialCmd(bus.dispatched)).not.toBeNull(); // attempted
    expect(bindCmd(bus.dispatched)).toBeNull(); // but never bound
    const errs = recentAssetsErrors().slice(errorsBefore);
    expect(errs.some((e) => e.op === 'createMaterial' && e.hint.includes('M_Wood') && e.hint.includes('not in the live asset catalog'))).toBe(true);
  });

  it('(t12) terminal bind-run failure (ASSET_NOT_FOUND) → user-visible error', async () => {
    const bus = makeBusStub([], {
      runResult: { ok: true, value: { status: 'failed', error: { hint: 'could not resolve catalogued asset GUID' } } },
    });
    const world = makeMaterialWorldStub();
    const renderer = makeMaterialRendererStub({ [TEX_GUID]: rgbaTexture(4, 4, 255) });
    installDragSpawnMeshResolver(bus as never, world as never, renderer as never);
    const errorsBefore = recentAssetsErrors().length;
    bus.fire(texSpawnCmd({ id: 7 }));
    await flush();

    expect(bindCmd(bus.dispatched)).not.toBeNull(); // bind was dispatched...
    const errs = recentAssetsErrors().slice(errorsBefore);
    // ...but its terminal failure does not die invisibly inside the OperationRun.
    expect(errs.some((e) => e.op === 'bindAssetRef' && e.hint.includes('M_Wood') && e.hint.includes('could not resolve catalogued asset GUID'))).toBe(true);
  });
});
