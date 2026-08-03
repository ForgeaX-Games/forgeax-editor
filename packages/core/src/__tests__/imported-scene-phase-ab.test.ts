import { describe, expect, it } from 'bun:test';
import { describeSceneActivation } from '../assets/scene-activation';
import { EditGateway } from '../io/gateway';
import { importedPreviewSession } from '../io/scene-authoring-session';
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

  it('reports source editing unavailable without inferring from file facts', () => {
    const facts = {
      guid: 'imported-guid',
      kind: 'scene',
      packageUrl: '/__forgeax-ddc/imported.pack.json',
      sourcePath: 'assets/Fox.glb',
      sourceKey: 'scene:main',
      metaPath: 'assets/Fox.glb.meta.json',
    };
    expect(describeSceneActivation(facts, [], 'ddc:r1')).toMatchObject({
      canEditSource: false,
      unavailable: {
        editSource: {
          recoveryActions: ['awaitEngineSourceAuthoringUpdate'],
        },
      },
    });

    const gateway = new EditGateway();
    const worldBefore = gateway.doc.world;
    const revisionBefore = gateway.rev;
    const rejected = gateway.dispatch({
      kind: 'editImportedSource',
      guid: 'imported-guid',
      sourceKey: 'scene:main',
      metaPath: 'assets/Fox.glb.meta.json',
      revision: 'ddc:r1',
      requestId: 'denied-source-edit',
    });
    expect(rejected).toMatchObject({
      ok: false,
      error: {
        code: 'engine-source-authoring-unavailable',
        retryable: false,
        recoveryActions: ['awaitEngineSourceAuthoringUpdate'],
      },
    });
    expect(gateway.dispatch({
      kind: 'saveImportedSource',
      requestId: 'denied-source-save',
    })).toMatchObject({
      ok: false,
      error: { code: 'engine-source-authoring-unavailable' },
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
    const internals = gateway as unknown as {
      _isMountMember(entity: number): boolean;
      _validateMountMemberEdit(op: object): { ok: boolean; error?: { code: string } };
    };
    internals._isMountMember = () => true;

    expect(internals._validateMountMemberEdit({
      kind: 'removeComponent', entity: 7, component: 'Transform',
    })).toMatchObject({ ok: false, error: { code: 'mount-member-operation-unsupported' } });
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
});
