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
