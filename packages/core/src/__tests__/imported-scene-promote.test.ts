import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Name, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry, type ShaderRegistryDevice } from '@forgeax/engine-shader';
import type { LocalEntityId, SceneAsset } from '@forgeax/engine-types';
import { createEditSession } from '../session/document';
import { gateway } from '../store/gateway';
import {
  ctx,
  type ScenePersistenceContext,
} from '../store/scene-persistence';
import {
  importedPreviewSession,
} from '../io/scene-authoring-session';
import { setPathResolver } from '../util/path-resolver';

const importedGuid = '11111111-1111-4111-8111-111111111111';
const sourceKey = 'scene:main';
const revision = 'ddc:r7';

function registry(): AssetRegistry {
  const device: ShaderRegistryDevice = {
    createShaderModule: () => ({
      ok: true,
      value: undefined,
      unwrap: () => undefined,
      unwrapOr: (fallback: unknown) => fallback,
    }) as never,
  };
  return new AssetRegistry(new ShaderRegistry({ device, manifestUrl: undefined }));
}

function scene(name: string): SceneAsset {
  return {
    kind: 'scene',
    entities: [{
      localId: 0 as LocalEntityId,
      components: {
        Name: { value: name },
        Transform: { pos: [0, 0, 0], scale: [1, 1, 1] },
      },
    }],
    mounts: [],
  };
}

type MutableContextSnapshot = Pick<
  ScenePersistenceContext,
  | 'currentSceneId'
  | 'currentSceneFile'
  | 'sceneList'
  | 'currentSceneGuid'
  | 'currentSceneEntities'
  | 'authoringSession'
  | 'previewState'
  | 'isDirty'
  | 'loadedInlineAssetFloor'
  | 'loadedInlineAssets'
  | 'loadedEntityFloor'
>;

describe.serial('imported scene Phase E Promote', () => {
  let originalFetch: typeof fetch;
  let originalCatalog: typeof gateway.assetCatalog;
  let originalDoc: typeof gateway.doc;
  let context: MutableContextSnapshot;
  let writes: Array<{ path: string; content: string }>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalCatalog = gateway.assetCatalog;
    originalDoc = gateway.doc;
    context = {
      currentSceneId: ctx.currentSceneId,
      currentSceneFile: ctx.currentSceneFile,
      sceneList: ctx.sceneList,
      currentSceneGuid: ctx.currentSceneGuid,
      currentSceneEntities: ctx.currentSceneEntities,
      authoringSession: ctx.authoringSession,
      previewState: ctx.previewState,
      isDirty: ctx.isDirty,
      loadedInlineAssetFloor: ctx.loadedInlineAssetFloor,
      loadedInlineAssets: ctx.loadedInlineAssets,
      loadedEntityFloor: ctx.loadedEntityFloor,
    };
    writes = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.startsWith('/api/files/raw?')) return new Response('', { status: 404 });
      if (url === '/api/files' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { path: string; content: string };
        writes.push(body);
        return new Response('{}', { status: 200 });
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;
    (gateway as unknown as { assetCatalog: typeof gateway.assetCatalog }).assetCatalog = ((options?: { compatibleWith?: string }) => {
      const rows = [{
        guid: importedGuid,
        kind: 'scene',
        packageUrl: '/__forgeax-ddc/imported.pack.json',
        sourceKey,
        revision: revision as never,
      }];
      return options?.compatibleWith === undefined ? rows : { ok: true as const, assets: [] };
    }) as typeof gateway.assetCatalog;
    ctx.currentSceneId = 'test-game';
    ctx.currentSceneFile = null;
    ctx.sceneList = [];
    ctx.currentSceneGuid = null;
    ctx.isDirty = false;
    ctx.loadedInlineAssetFloor = null;
    ctx.loadedInlineAssets = null;
    ctx.loadedEntityFloor = null;
    setPathResolver((path) => `/games/test/${path}`);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setPathResolver(null);
    (gateway as unknown as { assetCatalog: typeof gateway.assetCatalog }).assetCatalog = originalCatalog;
    gateway.replaceDoc(originalDoc);
    Object.assign(ctx, context);
  });

  function activatePreview(effective = scene('Effective')): void {
    const world = new World();
    const assets = registry();
    const doc = createEditSession();
    doc.world = world;
    doc.registry = assets;
    const instantiated = assets.instantiateFlat(world.allocSharedRef('SceneAsset', effective), world);
    if (!instantiated.ok) throw new Error('fixture instantiate failed');
    gateway.replaceDoc(doc);
    ctx.currentSceneEntities = [...instantiated.value];
    ctx.previewState = { guid: importedGuid, sourceKey, revision, effectiveScene: effective, world, registry: assets };
    ctx.authoringSession = importedPreviewSession(ctx.previewState);
  }

  it('creates one authored pack with Engine serialization and no invented source projection', async () => {
    activatePreview();
    const requestId = 'promote-effective';
    expect(gateway.dispatch({
      kind: 'promoteImportedScene',
      importedGuid,
      sourceKey,
      revision,
      targetPackPath: 'assets/scenes/effective.pack.json',
      targetName: 'Effective Authored',
      contentPolicy: 'effective-base',
      requestId,
    }, 'ai')).toMatchObject({ ok: true });
    const terminal = await gateway.waitOperationRun(requestId);
    expect(terminal).toMatchObject({ ok: true, value: { status: 'succeeded' } });
    expect(writes).toHaveLength(1);
    const pack = JSON.parse(writes[0]!.content);
    const entry = pack.assets.find((asset: { kind: string }) => asset.kind === 'scene');
    expect(entry.guid).not.toBe(importedGuid);
    expect(entry.name).toBe('Effective Authored');
    expect(entry.payload).not.toHaveProperty('sourceNodes');
    expect(writes[0]!.path).not.toContain('__forgeax-ddc');
    expect(ctx.authoringSession.mode).toBe('authored');
    expect(ctx.currentSceneGuid).toBe(entry.guid);
    expect(ctx.sceneList).toEqual([expect.objectContaining({
      pack: 'assets/scenes/effective.pack.json',
      guid: entry.guid,
    })]);
  });

  it('rejects current-session promotion before writes when source authoring is unavailable', () => {
    activatePreview(scene('Pristine'));
    const world = gateway.doc.world;
    expect(gateway.dispatch({
      kind: 'promoteImportedScene',
      importedGuid,
      sourceKey,
      revision,
      targetPackPath: 'assets/scenes/current.pack.json',
      targetName: 'Current',
      contentPolicy: 'current-session',
      requestId: 'promote-current',
    })).toMatchObject({
      ok: false,
      error: { code: 'promote-current-session-unavailable' },
    });
    expect(writes).toHaveLength(0);
    expect(gateway.doc.world).toBe(world);
    expect(ctx.authoringSession.mode).toBe('imported-preview');
    expect(gateway.getOperationRun('promote-current')).toMatchObject({
      status: 'failed',
      error: { code: 'promote-current-session-unavailable' },
    });
  });

  it('keeps the imported session and world intact when the target collides', async () => {
    activatePreview();
    const world = gateway.doc.world;
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    expect(gateway.dispatch({
      kind: 'promoteImportedScene',
      importedGuid,
      sourceKey,
      revision,
      targetPackPath: 'assets/scenes/existing.pack.json',
      targetName: 'Existing',
      contentPolicy: 'effective-base',
      requestId: 'promote-collision',
    })).toMatchObject({ ok: true });
    const terminal = await gateway.waitOperationRun('promote-collision');
    expect(terminal).toMatchObject({
      ok: true,
      value: { status: 'failed', error: { code: 'promote-target-collision' } },
    });
    expect(gateway.doc.world).toBe(world);
    expect(ctx.authoringSession.mode).toBe('imported-preview');
    expect(ctx.sceneList).toEqual([]);
  });
});
