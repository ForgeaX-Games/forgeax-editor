// A single real Gateway/product composition proof.
//
// The neighboring tests intentionally prove individual contracts. This fixture
// keeps the seams honest together: discovery, human/AI parity, product runs,
// structured rejection and confirmation, canonical save, fresh reopen, Play /
// Stop isolation, and product idempotency all use the existing owners.

import { expect, test } from 'bun:test';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Name, Transform } from '@forgeax/engine-scene';
import type { OperationRun } from '@forgeax/editor-product';
import { createGatewayCapabilityAdapter } from '../product/gateway-executor';
import { EditGateway } from '../io/gateway';
import { registerApplier, type SessionApplier } from '../io/appliers';
import { createEditSession } from '../session/document';
import { createDiskIo } from '../store/persistence/disk-io';
import { createScenePersistenceContext } from '../store/scene-persistence';
import type { EditSession } from '../types';

const IMPACT_TARGET_GUID = '00000000-0000-7000-8000-000000000031';
const IMPACT_REFERENCER_GUID = '00000000-0000-7000-8000-000000000032';

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function session(world: World, registry: AssetRegistry): EditSession {
  const value = createEditSession();
  value.world = world as unknown as EditSession['world'];
  value.registry = registry;
  return value;
}

function operationRuns(gateway: EditGateway) {
  return {
    get: (requestId: string) => gateway.getOperationRunResult(requestId),
    wait: (requestId: string) => gateway.waitOperationRun(requestId),
    subscribe: (requestId: string, listener: (run: OperationRun) => void) => gateway.subscribeOperationRun(requestId, listener),
    cancel: (requestId: string) => gateway.cancelOperationRun(requestId),
    retry: (requestId: string, retryRequestId: string, actor: { id: string; kind: string }) => gateway.operationRuns.retry(requestId, retryRequestId, actor),
  };
}

test('real EditGateway and product adapter preserve one AI-usable round trip', async () => {
  const world = new World();
  const registry = new AssetRegistry({} as never);
  const gateway = new EditGateway(session(world, registry));
  const ctx = createScenePersistenceContext();
  ctx.currentSceneId = 'roundtrip';

  const spawned = world.spawn(
    { component: Name, data: { value: 'RoundtripRoot' } },
    { component: Transform, data: { pos: [1, 2, 3] } },
  );
  expect(spawned.ok).toBe(true);
  if (!spawned.ok) return;
  const entity = spawned.value;

  // Use the existing engine catalog relation projection to exercise the
  // structured destructive-confirmation read without defining a new policy.
  expect(registry.catalog(IMPACT_TARGET_GUID, { kind: 'scene', entities: [] }, []).ok).toBe(true);
  expect(registry.catalog(
    IMPACT_REFERENCER_GUID,
    { kind: 'scene', entities: [] },
    [{ guid: IMPACT_TARGET_GUID }],
  ).ok).toBe(true);

  let savedContent: string | null = null;
  const fetch = async (path: string, init?: RequestInit): Promise<Response> => {
    if (path === '/api/files' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { path?: string; content?: string };
      savedContent = body.content ?? null;
      return responseJson({ ok: true });
    }
    throw new Error(`unexpected fixture fetch: ${path}`);
  };
  const fetchWithTimeout = async (_url: string): Promise<Response> => responseJson({ content: savedContent ?? '' });
  const deps = {
    ctx,
    gateway,
    fetch,
    fetchWithTimeout,
    resolveGamePath: (relative: string) => `/games/roundtrip/${relative}`,
    notifyDocChanged: () => {},
  };
  const diskIo = createDiskIo(deps);
  const restoreSaveApplier = registerApplier('session', 'saveDocToDisk', ((_op, _applierCtx) => {
    const completion = diskIo.doSaveDocToDisk({ acceptedRevision: gateway.rev });
    completion.catch(() => {});
    return { ok: true, completion };
  }) as SessionApplier);
  const adapter = createGatewayCapabilityAdapter({
    listOps: () => gateway.listOps(),
    dispatch: (command, origin) => gateway.dispatch(command, origin),
    operationRuns: operationRuns(gateway),
  });

  try {
    const discovered = adapter.capabilities();
    expect(discovered.some((capability) => capability.id === 'editor.rename')).toBe(true);
    expect(discovered.some((capability) => capability.id === 'editor.saveDocToDisk')).toBe(true);

    const humanRename = gateway.dispatch({ kind: 'rename', entity, name: 'HumanRename' }, 'human');
    expect(humanRename).toMatchObject({ ok: true });
    const aiRename = await adapter.product().capabilityRegistry.execute(
      'editor.rename',
      { entity, name: 'AiRename' },
      { host: 'bun' },
    );
    expect(aiRename).toMatchObject({ ok: true, result: { ok: true } });
    expect(gateway.origins.slice(-2)).toEqual(['human', 'ai']);

    const invalid = await adapter.product().capabilityRegistry.execute(
      'editor.rename',
      { name: 'missing-entity' },
      { host: 'bun' },
    );
    expect(invalid).toMatchObject({
      ok: true,
      result: { ok: false, error: { code: 'INVALID_ARGS', hint: expect.any(String) } },
    });
    expect(JSON.parse(JSON.stringify(invalid))).toMatchObject({
      ok: true,
      result: { ok: false, error: { code: 'INVALID_ARGS', retryable: false, recoveryActions: [] } },
    });

    const impact = gateway.assetImpact({ operation: 'delete', guid: IMPACT_TARGET_GUID });
    expect(impact).toMatchObject({
      resolution: 'resolved',
      blocking: true,
      confirmation: { required: true },
      directReferencers: [{ guid: IMPACT_REFERENCER_GUID }],
    });

    const replayRequest = {
      runId: 'roundtrip-replay-run',
      requestId: 'roundtrip-replay-request',
      idempotencyKey: 'roundtrip-replay-key',
      actor: { id: 'ai', kind: 'ai' as const },
      sessionId: 'roundtrip-session',
      scope: 'roundtrip-game',
    };
    const firstReplay = adapter.dispatchRun(
      'rename',
      { entity, name: 'ReplayRename' },
      replayRequest,
    );
    expect(firstReplay).toMatchObject({ ok: true, reused: false });
    if (!firstReplay.ok) return;
    expect(adapter.getRun(firstReplay.runId)).toMatchObject({
      operationId: 'rename',
      status: 'succeeded',
    });
    const ledgerAfterReplay = gateway.ledger.length;
    const duplicateReplay = adapter.dispatchRun(
      'rename',
      { entity, name: 'ReplayRename' },
      { ...replayRequest, runId: 'roundtrip-replay-duplicate' },
    );
    expect(duplicateReplay).toMatchObject({ ok: true, reused: true, runId: firstReplay.runId });
    expect(gateway.ledger.length).toBe(ledgerAfterReplay);

    const save = await adapter.product().capabilityRegistry.execute(
      'editor.saveDocToDisk',
      { requestId: 'roundtrip-save-request' },
      { host: 'bun' },
    );
    expect(save).toMatchObject({
      ok: true,
      result: {
        ok: true,
        result: { operationRun: { requestId: 'roundtrip-save-request', status: 'succeeded' } },
      },
    });
    expect(savedContent).toEqual(expect.any(String));

    const diagnostics = gateway.diagnostics.snapshot();
    expect(diagnostics).toMatchObject({
      schemaVersion: 'diagnostics/v1',
      operationRuns: { runs: expect.arrayContaining([expect.objectContaining({ operationId: 'saveDocToDisk', status: 'succeeded' })]) },
    });

    const savedPack = JSON.parse(savedContent!) as {
      assets?: Array<{ guid?: string; kind?: string; payload?: unknown }>;
    };
    const sceneEntry = savedPack.assets?.find((asset) => asset.kind === 'scene');
    expect(sceneEntry?.guid).toEqual(expect.any(String));
    const persistedPayload = sceneEntry?.payload === undefined ? undefined : structuredClone(sceneEntry.payload);
    expect((persistedPayload as { entities?: unknown[] } | undefined)?.entities).toBeInstanceOf(Array);
    if (sceneEntry?.guid === undefined || sceneEntry.payload === undefined) return;

    // Reopen with a fresh World and registry, but through the same canonical
    // loadSceneByGuid -> instantiateFlat path used by the Editor.
    const reopenedWorld = new World();
    const reopenedRegistry = new AssetRegistry({} as never);
    expect(reopenedRegistry.catalog(sceneEntry.guid, persistedPayload as never, []).ok).toBe(true);
    const reopenedGateway = new EditGateway(session(reopenedWorld, reopenedRegistry));
    const reopenedCtx = createScenePersistenceContext();
    reopenedCtx.currentSceneId = 'roundtrip';
    const reopenedIo = createDiskIo({
      ctx: reopenedCtx,
      gateway: reopenedGateway,
      fetch,
      fetchWithTimeout,
      resolveGamePath: (relative: string) => `/games/roundtrip/${relative}`,
      notifyDocChanged: () => {},
    });
    expect(await reopenedIo.doLoadDocFromDisk()).toBe(true);
    const reopenedEntity = reopenedCtx.currentSceneEntities[0];
    expect(reopenedEntity).toBeDefined();
    if (reopenedEntity === undefined) return;
    expect(reopenedWorld.get(reopenedEntity, Name)).toMatchObject({ ok: true, value: { value: 'ReplayRename' } });

    const playWorld = new World();
    const playAsset = reopenedRegistry.lookup(sceneEntry.guid);
    expect(playAsset).toBeDefined();
    if (playAsset === undefined) return;
    const playHandle = playWorld.allocSharedRef('SceneAsset', playAsset);
    const playRoots = reopenedRegistry.instantiateFlat(playHandle, playWorld);
    expect(playRoots).toMatchObject({ ok: true });
    if (!playRoots.ok) return;
    const playEntity = playRoots.value[0];
    expect(playEntity).toBeDefined();
    if (playEntity === undefined) return;
    expect(playWorld.get(playEntity, Name)).toMatchObject({ ok: true, value: { value: 'ReplayRename' } });

    reopenedGateway.enterPlay(playWorld);
    expect(reopenedGateway.mode).toBe('play');
    expect(reopenedGateway.activeWorld).toBe(playWorld);
    expect(reopenedGateway.dispatch({ kind: 'rename', entity: reopenedEntity, name: 'must-stop-first' }, 'ai')).toMatchObject({
      ok: false,
      error: { code: 'edit-rejected-in-play' },
    });
    reopenedGateway.exitPlay();
    expect(reopenedGateway.mode).toBe('edit');
    expect(reopenedGateway.activeWorld).toBe(reopenedWorld);
    expect(reopenedWorld.get(reopenedEntity, Name)).toMatchObject({ ok: true, value: { value: 'ReplayRename' } });
  } finally {
    adapter.dispose();
    restoreSaveApplier();
  }
});
