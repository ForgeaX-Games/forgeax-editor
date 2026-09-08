import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { AssetRegistry, createCatalogSource, resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { worldGetSceneAssetForInstance } from '@forgeax/engine-scene';
import type { AssetPublicationEnvelope, SceneAsset } from '@forgeax/engine-types';
import { describeSceneActivation } from '../assets/scene-activation';
import { EditGateway } from '../io/gateway';
import { createCoreTestWorld } from './fixtures/world';
import { importedPreviewSession } from '../io/scene-authoring-session';
import { createEditSession } from '../session/document';
import { ctx, loadImportedScenePreview } from '../store/scene-persistence';

describe('imported scene Phase A descriptor and gateway policy', () => {
  it('derives authored and imported activation from catalog/workspace facts', () => {
    const authored = describeSceneActivation(
      { guid: 'authored-guid', kind: 'scene', packageUrl: 'assets/main.pack.json' },
      [{ id: 'main', guid: 'authored-guid' }],
      'workspace:r1',
    );
    expect(authored).toMatchObject({
      provenance: 'authored-pack',
      mode: 'open-authored',
      authoredSceneId: 'main',
    });

    const imported = describeSceneActivation(
      {
        guid: 'imported-guid',
        kind: 'scene',
        packageUrl: '/__forgeax-ddc/imported.pack.json',
        sourcePath: 'assets/Fox.glb',
        sourceKey: 'assets/Fox.glb',
        authoring: { placement: { operation: 'addSceneAssetToScene' } },
      },
      [{ id: 'main', guid: 'authored-guid' }],
      'workspace:r2',
    );
    expect(imported).toMatchObject({
      provenance: 'imported-output',
      mode: 'preview-imported',
      sourceKey: 'assets/Fox.glb',
      canMount: true,
    });
  });

  it('rejects document and save operations in imported preview before effects', () => {
    const gateway = new EditGateway();
    gateway.registerSceneAuthoringSessionProvider(() => importedPreviewSession());

    expect(gateway.dispatch({ kind: 'spawnEntity', name: 'Nope' })).toMatchObject({
      ok: false,
      error: {
        code: 'edit-rejected-in-imported-preview',
        recoveryActions: ['addSceneAssetToScene', 'promoteImportedScene'],
      },
    });
    expect(gateway.dispatch({ kind: 'saveDocToDisk', requestId: 'preview-save' })).toMatchObject({
      ok: false,
      error: {
        code: 'save-rejected-in-imported-preview',
        recoveryActions: ['addSceneAssetToScene', 'promoteImportedScene'],
      },
    });
    expect(gateway.getOperationRun('preview-save')).toBeUndefined();
  });

  it('keeps source authoring out of scene activation facts until the operation is available', () => {
    const facts = {
      guid: 'imported-guid',
      kind: 'scene',
      packageUrl: '/__forgeax-ddc/imported.pack.json',
      sourcePath: 'assets/Fox.glb',
      sourceKey: 'scene:main',
      metaPath: 'assets/Fox.glb.meta.json',
    };
    const descriptor = describeSceneActivation(facts, [], 'ddc:r1');
    expect(descriptor).toMatchObject({
      provenance: 'imported-output',
      guid: 'imported-guid',
      sourceKey: 'scene:main',
      mode: 'preview-imported',
    });
    expect(descriptor).not.toHaveProperty('canEditSource');

    const gateway = new EditGateway();
    const worldBefore = gateway.doc.world;
    const revisionBefore = gateway.rev;
    const rejected = gateway.dispatch({
      kind: 'saveAssetSourceOverride',
      guid: 'imported-guid',
      scope: { sourceKey: 'scene:main' },
      expectedRevision: 'ddc:r1',
      requestId: 'denied-source-edit',
    });
    expect(rejected).toMatchObject({
      ok: false,
      error: {
        code: expect.stringMatching(/UNKNOWN_OP|unavailable|source-authoring/),
      },
    });
    expect(gateway.dispatch({
      kind: 'previewAssetSourceMutation',
      guid: 'imported-guid',
      scope: { sourceKey: 'scene:main' },
      expectedRevision: 'ddc:r1',
      requestId: 'denied-source-save',
    })).toMatchObject({
      ok: false,
      error: { code: expect.stringMatching(/UNKNOWN_OP|unavailable|source-authoring/) },
    });
    expect(gateway.doc.world).toBe(worldBefore);
    expect(gateway.rev).toBe(revisionBefore);
    expect(gateway.getOperationRun('denied-source-edit')).toBeUndefined();
    expect(gateway.getOperationRun('denied-source-save')).toBeUndefined();
  });

  it('rejects imported preview activation while the authored scene is dirty', () => {
    const gateway = new EditGateway();
    const previousDirty = ctx.isDirty;
    const previousSession = ctx.authoringSession;
    try {
      ctx.isDirty = true;
      ctx.authoringSession = {
        mode: 'authored',
        canMutate: true,
        saveTarget: 'scene-pack',
        reason: null,
      };
      expect(gateway.dispatch({
        kind: 'previewImportedScene',
        guid: 'imported-guid',
        sourceKey: 'assets/Fox.glb',
        revision: 'ddc:r1',
        requestId: 'dirty-preview',
      })).toMatchObject({
        ok: false,
        error: {
          code: 'preview-rejected-dirty',
          recoveryActions: ['saveDocToDisk', 'cancel'],
        },
      });
    } finally {
      ctx.isDirty = previousDirty;
      ctx.authoringSession = previousSession;
    }
  });

  it('loads preview by GUID and publishes imported-preview source facts', async () => {
    const loaded: string[] = [];
    let mode: unknown = null;
    expect(await loadImportedScenePreview({
      guid: 'imported-guid',
      sourceKey: 'fox-scene',
      sourcePath: 'assets/Fox.glb',
      revision: 'ddc:r7',
    }, {
      loadByGuid: async (guid) => { loaded.push(guid); return true; },
      activate: (session) => { mode = session; },
    })).toBe(true);
    expect(loaded).toEqual(['imported-guid']);
    expect(mode).toMatchObject({
      mode: 'imported-preview',
      canMutate: false,
      saveTarget: null,
    });
  });

  it('rejects unsupported mount-member edits without blocking supported operations', () => {
    const gateway = new EditGateway();
    gateway.doc.world = createCoreTestWorld();
    const internals = gateway as unknown as {
      _isMountMember(entity: number): boolean;
      _mountMemberPublicationIdentity(entity: number): {
        sourcePath: string;
        sourceKey: string;
        outputGuid: string;
        expectedRevision: string;
        actualRevision: string;
        candidateGeneration: number;
        currentGeneration: number;
      };
      _validateMountMemberEdit(op: object): { ok: boolean; error?: { code: string; details?: unknown } };
    };
    internals._isMountMember = () => true;
    internals._mountMemberPublicationIdentity = () => ({
      sourcePath: 'assets/procedural-showcase.pack.ts',
      sourceKey: 'scene:arena',
      outputGuid: '11111111-1111-4111-8111-111111111111',
      expectedRevision: 'a'.repeat(64),
      actualRevision: 'b'.repeat(64),
      candidateGeneration: 3,
      currentGeneration: 4,
    });

    const rejection = internals._validateMountMemberEdit({
      kind: 'removeComponent', entity: 7, component: 'Transform',
    });
    expect(rejection).toMatchObject({ ok: false, error: { code: 'mount-member-operation-unsupported' } });
    expect(rejection.error).toMatchObject({
      details: {
        sourcePath: 'assets/procedural-showcase.pack.ts',
        sourceKey: 'scene:arena',
        outputGuid: '11111111-1111-4111-8111-111111111111',
        expectedRevision: 'a'.repeat(64),
        actualRevision: 'b'.repeat(64),
        candidateGeneration: 3,
        currentGeneration: 4,
      },
    });
    expect(internals._validateMountMemberEdit({
      kind: 'destroyEntity', entity: 7,
    })).toMatchObject({ ok: false, error: { code: 'mount-member-operation-unsupported' } });
    expect(internals._validateMountMemberEdit({
      kind: 'reparent', entity: 7, parent: null,
    })).toMatchObject({ ok: false, error: { code: 'mount-member-operation-unsupported' } });
    expect(internals._validateMountMemberEdit({
      kind: 'setComponent', entity: 7, component: 'ChildOf', patch: { parent: 9 },
    })).toMatchObject({ ok: false, error: { code: 'mount-member-operation-unsupported' } });
    expect(internals._validateMountMemberEdit({
      kind: 'addComponent', entity: 7, component: 'AnimationPlayer', value: {},
    })).toEqual({ ok: true });
  });

  it('derives mount publication identity from a live SceneInstance and AssetRegistry', async () => {
    const childGuid = '11111111-1111-4111-8111-111111111111';
    const parentGuid = '22222222-2222-4222-8222-222222222222';
    const publication: AssetPublicationEnvelope = {
      schemaVersion: 'asset-publication/1',
      sourcePath: 'assets/procedural-showcase.pack.ts',
      sourceRevision: 'revision-current',
      generation: 4,
      digest: 'sha256:publication-current',
      outputSetDigest: 'sha256:outputs-current',
      outputs: [{ guid: childGuid, sourceKey: 'scene/arena', kind: 'scene', digest: 'sha256:scene-current', refs: [] }],
      receipt: {
        schemaVersion: 'asset-publication-receipt/1',
        sourcePath: 'assets/procedural-showcase.pack.ts',
        sourceRevision: 'revision-current',
        inputFingerprint: 'sha256:receipt-current',
        outputDigest: 'sha256:publication-current',
        outputSetDigest: 'sha256:outputs-current',
        externalEvidence: [],
      },
      externalEvidence: [],
    };
    const fence = {
      schemaVersion: 'scene-publication-fence/1' as const,
      sourcePath: publication.sourcePath,
      sourceRevision: publication.sourceRevision,
      publicationGeneration: publication.generation,
      outputDigest: publication.digest,
      outputSetDigest: publication.outputSetDigest,
      receiptIdentity: publication.receipt.inputFingerprint,
    };
    const child: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: {} } }],
    };
    const parent: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: {} } }],
      mounts: [{ localId: 1 as never, source: childGuid, memberFirst: 2 as never, memberCount: 1 }],
    };
    const registry = new AssetRegistry({} as never);
    expect(registry.catalog(childGuid, child).ok).toBe(true);
    expect(registry.catalog(parentGuid, parent).ok).toBe(true);
    registry.setCatalogSource(createCatalogSource({
      entries: [
        { guid: childGuid, kind: 'scene', packageUrl: 'scene.pack.json', sourcePath: publication.sourcePath, sourceKey: 'scene/arena', publication },
        { guid: parentGuid, kind: 'scene', packageUrl: 'scene.pack.json', sourcePath: 'assets/main.pack.ts', sourceKey: 'scene/main' },
      ],
    }));
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const world = createCoreTestWorld();
    const parentHandle = world.allocSharedRef('SceneAsset', parent);
    const instantiated = registry.instantiate(parentHandle, world);
    expect(instantiated.ok).toBe(true);
    if (!instantiated.ok) return;
    const sourceHandle = worldGetSceneAssetForInstance(world, instantiated.value);
    expect(sourceHandle.ok).toBe(true);
    if (!sourceHandle.ok) return;
    const liveParent = resolveAssetHandle(world, sourceHandle.value);
    expect(liveParent.ok).toBe(true);
    if (!liveParent.ok || liveParent.value.kind !== 'scene' || liveParent.value.mounts?.[0] === undefined) return;
    const candidateFence = {
      ...fence,
      sourceRevision: 'revision-candidate',
      publicationGeneration: 3,
      outputDigest: 'sha256:publication-candidate',
      outputSetDigest: 'sha256:outputs-candidate',
      receiptIdentity: 'sha256:receipt-candidate',
    };
    (liveParent.value.mounts[0] as { publicationFence?: unknown }).publicationFence = candidateFence;
    const session = createEditSession();
    session.world = world;
    session.registry = registry;
    const gateway = new EditGateway(session);
    const models = gateway.sceneInstancesReadModel();
    const childInstance = models.find((model) => model.source.guid === childGuid);
    expect(childInstance?.members).toHaveLength(1);
    const member = childInstance?.members[0]?.entity;
    expect(member).toBeDefined();
    if (member === undefined) return;
    const identity = (gateway as unknown as {
      _mountMemberPublicationIdentity(entity: number): Record<string, unknown> | undefined;
    })._mountMemberPublicationIdentity(member);
    expect(identity).toMatchObject({
      sourcePath: publication.sourcePath,
      sourceKey: 'scene/arena',
      outputGuid: childGuid,
      expectedRevision: candidateFence.sourceRevision,
      actualRevision: publication.sourceRevision,
      candidateGeneration: candidateFence.publicationGeneration,
      currentGeneration: publication.generation,
      publicationFence: candidateFence,
    });
  });
});
