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
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { installDragSpawnMeshResolver } from '../viewport/drag-spawn-resolve';

// A syntactically valid RFC 4122 dash-form UUID (AssetGuid.parse accepts it).
const GOOD_GUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface DispatchedCmd { cmd: EditorOp; origin?: string }

/** Minimal bus stub: captures the subscribed listener + dispatched commands. */
function makeBusStub() {
  let listener: ((doc: unknown, lastCommand: EditorOp | null) => void) | null = null;
  const dispatched: DispatchedCmd[] = [];
  return {
    subscribe(fn: (doc: unknown, lastCommand: EditorOp | null) => void) {
      listener = fn;
      return () => { listener = null; };
    },
    dispatch(cmd: EditorOp, origin?: string) {
      dispatched.push({ cmd, origin });
      return { ok: true as const };
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
