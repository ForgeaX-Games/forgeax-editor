import { describe, expect, it } from 'bun:test';
import { listOps } from '../io/catalog';
import {
  GENERATED_SCENE_RECOVERY_ACTIONS,
  generatedSceneOperationManifest,
  validateGeneratedSceneOperation,
} from '../session/scriptable-pack-ops';
import '../index';

describe('generated Scene operation boundary', () => {
  it('keeps generated source and structure read-only', () => {
    expect(validateGeneratedSceneOperation({ kind: 'inspect', target: 'source' })).toEqual({ ok: true });
    expect(validateGeneratedSceneOperation({ kind: 'preview', target: 'structure' })).toEqual({ ok: true });

    const rejected = validateGeneratedSceneOperation({
      kind: 'destroyEntity',
      target: 'structure',
      sourcePath: 'assets/showcase.pack.ts',
      outputGuid: 'scene-output',
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error).toMatchObject({
      code: 'generated-scene-read-only',
      phase: 'validation',
      sourcePath: 'assets/showcase.pack.ts',
      outputGuid: 'scene-output',
      retryable: false,
      recoveryActions: GENERATED_SCENE_RECOVERY_ACTIONS,
    });
  });

  it('allows ordinary placement, default, override, save, and play consumers', () => {
    for (const kind of ['addSceneAssetToScene', 'setDefaultScene', 'setSceneOverride', 'saveDocToDisk', 'play']) {
      expect(validateGeneratedSceneOperation({ kind, target: 'ordinary' })).toEqual({ ok: true });
    }
    const manifestKinds = generatedSceneOperationManifest().map((entry) => entry.id);
    for (const kind of [
      'asset.preflight',
      'asset-source.rebuild',
      'asset-source.cold-cook',
      'addSceneAssetToScene',
      'setDefaultScene',
      'setSceneOverride',
      'saveDocToDisk',
      'play',
    ]) expect(manifestKinds).toContain(kind);
    expect(manifestKinds.some((id) => id.includes('addScriptableScene') || id.includes('setScriptableDefault'))).toBe(false);
  });

  it('keeps the public consumer payload and terminal contract discoverable', () => {
    for (const id of ['addSceneAssetToScene', 'setDefaultScene', 'setSceneOverride', 'saveDocToDisk', 'play']) {
      const descriptor = listOps().find((entry) => entry.id === id);
      expect(descriptor, id).toBeDefined();
      expect(descriptor?.argsSchema).toBeDefined();
      if (id === 'addSceneAssetToScene' || id === 'setDefaultScene') {
        expect(descriptor?.operationRun?.terminalStatuses).toEqual(['succeeded', 'failed']);
      }
    }
  });
});
