import { describe, expect, it } from 'bun:test';
import { sceneActivationToOp, scenePromoteToOp } from './scene-activation-route';
import type { SceneActivationDescriptor } from '@forgeax/editor-core';

const base: SceneActivationDescriptor = {
  subjectKind: 'scene',
  provenance: 'imported-output',
  revision: 'workspace:r4',
  sourceKey: 'assets/Fox.glb',
  guid: 'scene-guid',
  mode: 'preview-imported',
  canPreview: true,
  canMount: true,
  canEditInstance: true,
  canPromote: true,
};

describe('Content Browser scene activation route', () => {
  it('routes authored descriptors to switchSceneFile', () => {
    expect(sceneActivationToOp({
      ...base,
      provenance: 'authored-pack',
      mode: 'open-authored',
      authoredSceneId: 'main',
    })).toMatchObject({ kind: 'switchSceneFile', id: 'main', requestId: expect.any(String) });
  });

  it('routes imported descriptors by GUID without scene-list/path guessing', () => {
    expect(sceneActivationToOp(base, 'assets/Fox.glb', 'preview-request')).toEqual({
      kind: 'previewImportedScene',
      guid: 'scene-guid',
      sourceKey: 'assets/Fox.glb',
      sourcePath: 'assets/Fox.glb',
      revision: 'workspace:r4',
      requestId: 'preview-request',
    });
  });


  it('projects explicit Promote intent without inferring path or content policy', () => {
    expect(scenePromoteToOp(base, {
      targetPackPath: 'assets/scenes/fox-authored.pack.json',
      targetName: 'Fox Authored',
      contentPolicy: 'effective-base',
    }, 'promote-request')).toEqual({
      kind: 'promoteImportedScene',
      importedGuid: 'scene-guid',
      sourceKey: 'assets/Fox.glb',
      revision: 'workspace:r4',
      targetPackPath: 'assets/scenes/fox-authored.pack.json',
      targetName: 'Fox Authored',
      contentPolicy: 'effective-base',
      requestId: 'promote-request',
    });
    expect(() => scenePromoteToOp({ ...base, canPromote: false }, {
      targetPackPath: 'assets/scenes/nope.pack.json',
      targetName: 'Nope',
      contentPolicy: 'effective-base',
    })).toThrow();
  });
});
