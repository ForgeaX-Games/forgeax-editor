// A single real Gateway/product composition proof.
//
// The neighboring tests intentionally prove individual contracts. This fixture
// keeps the seams honest together: discovery, human/AI parity, product runs,
// structured rejection and confirmation, canonical save, fresh reopen, Play /
// Stop isolation, and product idempotency all use the existing owners.

import { expect, test } from 'bun:test';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { HANDLE_CUBE, HANDLE_QUAD, parseScenePayload } from '@forgeax/engine-assets-runtime';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { ChildOf, Name, Transform } from '@forgeax/engine-scene';
import type { OperationRun } from '@forgeax/editor-product';
import { createGatewayCapabilityAdapter } from '../product/gateway-executor';
import { EditGateway } from '../io/gateway';
import { registerApplier, type SessionApplier } from '../io/appliers';
import { createEditSession } from '../session/document';
import { createDiskIo } from '../store/persistence/disk-io';
import { createScenePersistenceContext } from '../store/scene-persistence';
import type { EditSession } from '../types';
import { createCoreTestWorld } from './fixtures/world';

const IMPACT_TARGET_GUID = '00000000-0000-7000-8000-000000000031';
const IMPACT_REFERENCER_GUID = '00000000-0000-7000-8000-000000000032';
const RED_MATERIAL_GUID = '00000000-0000-7000-8000-000000000041';
const BLUE_MATERIAL_GUID = '00000000-0000-7000-8000-000000000042';

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
  const world = createCoreTestWorld([MeshFilter, MeshRenderer]);
  const registry = new AssetRegistry({} as never);
  const gateway = new EditGateway(session(world, registry));
  const ctx = createScenePersistenceContext();
  ctx.currentSceneId = 'roundtrip';

  const redMaterial = Materials.unlit([0.8, 0.1, 0.1, 1]);
  const blueMaterial = Materials.unlit([0.1, 0.2, 0.8, 1]);
  const redGuid = AssetGuid.parse(RED_MATERIAL_GUID);
  const blueGuid = AssetGuid.parse(BLUE_MATERIAL_GUID);
  expect(redGuid.ok).toBe(true);
  expect(blueGuid.ok).toBe(true);
  if (!redGuid.ok || !blueGuid.ok) return;
  expect(registry.catalog(redGuid.value, redMaterial).ok).toBe(true);
  expect(registry.catalog(blueGuid.value, blueMaterial).ok).toBe(true);
  const redMaterialHandle = world.allocSharedRef('MaterialAsset', redMaterial);
  const blueMaterialHandle = world.allocSharedRef('MaterialAsset', blueMaterial);
  const spawned = gateway.dispatch({
    kind: 'spawnEntity', name: 'RoundtripRoot',
    components: {
      Transform: { pos: [1, 2, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
      MeshFilter: { assetHandle: HANDLE_CUBE },
      MeshRenderer: { materials: [redMaterialHandle] },
    },
  }, 'ai');
  expect(spawned.ok).toBe(true);
  if (!spawned.ok) return;
  const entity = spawned.result?.created[0];
  expect(entity).toBeDefined();
  if (entity === undefined) return;
  const childOne = gateway.dispatch({
    kind: 'spawnEntity', name: 'RoundtripChildOne', parent: entity,
    components: {
      Transform: { pos: [2, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
      MeshFilter: { assetHandle: HANDLE_QUAD },
      MeshRenderer: { materials: [blueMaterialHandle] },
    },
  }, 'ai');
  expect(childOne).toMatchObject({ ok: true });
  const childTwo = gateway.dispatch({
    kind: 'spawnEntity', name: 'RoundtripChildTwo', parent: entity,
    components: {
      Transform: { pos: [-2, 0, 0], quat: [0, 0, 0, 1], scale: [0.5, 0.5, 0.5] },
      MeshFilter: { assetHandle: HANDLE_CUBE },
      MeshRenderer: { materials: [redMaterialHandle] },
    },
  }, 'ai');
  expect(childTwo).toMatchObject({ ok: true });
  if (!childOne.ok || !childTwo.ok) return;
  const visibleParts: Array<EntityHandle | undefined> = [entity, childOne.result?.created[0], childTwo.result?.created[0]];
  expect(visibleParts.every((part) => part !== undefined)).toBe(true);
  if (visibleParts.some((part) => part === undefined)) return;
  for (const part of visibleParts as EntityHandle[]) {
    expect(world.get(part, MeshFilter)).toMatchObject({ ok: true });
    expect(world.get(part, MeshRenderer)).toMatchObject({ ok: true });
  }

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
      assets?: Array<{ guid?: string; kind?: string; payload?: unknown; refs?: string[] }>;
    };
    const sceneEntry = savedPack.assets?.find((asset) => asset.kind === 'scene');
    expect(sceneEntry?.guid).toEqual(expect.any(String));
    const persistedPayload = sceneEntry?.payload === undefined ? undefined : structuredClone(sceneEntry.payload);
    expect((persistedPayload as { entities?: unknown[] } | undefined)?.entities).toBeInstanceOf(Array);
    if (sceneEntry?.guid === undefined || sceneEntry.payload === undefined) return;

    // Reopen with a fresh World and registry, but through the same canonical
    // loadSceneByGuid -> instantiateFlat path used by the Editor.
    const reopenedWorld = createCoreTestWorld([MeshFilter, MeshRenderer]);
    const reopenedRegistry = new AssetRegistry({} as never);
    for (const asset of savedPack.assets ?? []) {
      if (asset.guid === undefined || asset.kind !== 'material' || asset.payload === undefined) continue;
      const guid = AssetGuid.parse(asset.guid);
      expect(guid.ok).toBe(true);
      if (guid.ok) expect(reopenedRegistry.catalog(guid.value, asset.payload as never).ok).toBe(true);
    }
    const parsedScene = parseScenePayload(persistedPayload as Record<string, unknown>, sceneEntry.refs);
    expect(parsedScene).toBeDefined();
    if (parsedScene === undefined || 'localId' in parsedScene) return;
    expect(reopenedRegistry.catalog(sceneEntry.guid, parsedScene as never, []).ok).toBe(true);
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
    const reopenedRows: Array<{ entity: EntityHandle }> = [];
    for (const row of reopenedWorld.query({ with: [Name, Transform, MeshFilter, MeshRenderer] }).unwrap()) {
      reopenedRows.push({ entity: row.entity as EntityHandle });
    }
    expect(reopenedRows).toHaveLength(3);
    expect(reopenedRows.map((row) => row.entity)).toEqual(expect.arrayContaining([reopenedEntity]));
    const reopenedNames = reopenedRows.map((row) => reopenedWorld.get(row.entity, Name).unwrap().value);
    expect(reopenedNames).toEqual(expect.arrayContaining(['ReplayRename', 'RoundtripChildOne', 'RoundtripChildTwo']));
    const reopenedChildren: unknown[] = [];
    for (const row of reopenedWorld.query({ with: [ChildOf] }).unwrap()) reopenedChildren.push(row);
    expect(reopenedChildren).toHaveLength(2);
    const rootTransform = reopenedWorld.get(reopenedEntity, Transform).unwrap();
    expect(Array.from(rootTransform.pos)).toEqual([1, 2, 3]);
    const reopenedMeshes = reopenedRows.map((row) => reopenedWorld.get(row.entity, MeshFilter).unwrap().assetHandle);
    expect(reopenedMeshes.every((handle) => handle !== 0)).toBe(true);
    expect(new Set(reopenedMeshes).size).toBe(2);
    const reopenedMaterials = reopenedRows.map((row) => reopenedWorld.get(row.entity, MeshRenderer).unwrap().materials);
    expect(reopenedMaterials.every((materials) => materials.length === 1 && materials[0] !== 0)).toBe(true);

    const playWorld = createCoreTestWorld([MeshFilter, MeshRenderer]);
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
    let playVisibleCount = 0;
    for (const _row of playWorld.query({ with: [Name, Transform, MeshFilter, MeshRenderer] }).unwrap()) playVisibleCount += 1;
    expect(playVisibleCount).toBe(3);

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
