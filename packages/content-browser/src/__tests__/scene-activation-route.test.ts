import { describe, expect, it } from 'bun:test';
import { catalogSceneVirtualPaths, sceneActivationToOp, scenePromoteToOp } from '../scene-activation-route';
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
  it('projects catalog-only defaults into the Scenes folder without changing authored paths', () => {
    const paths = catalogSceneVirtualPaths([
      {
        id: 'default',
        name: 'Default Scene',
        pack: null,
        guid: 'DEFAULT-GUID',
        provenance: 'catalog-default',
        isCurrent: false,
        isDefault: true,
      },
      {
        id: 'level-2',
        name: 'Level 2',
        pack: 'assets/scenes/level-2.pack.json',
        guid: 'AUTHORED-GUID',
        isCurrent: true,
        isDefault: false,
      },
    ]);

    expect(paths.get('default-guid')).toBe('assets/scenes/default.scene');
    expect(paths.has('authored-guid')).toBe(false);
  });

  it('routes authored descriptors to switchSceneFile', () => {
    expect(sceneActivationToOp({
      ...base,
      provenance: 'authored-pack',
      mode: 'open-authored',
      authoredSceneId: 'main',
    })).toMatchObject({ kind: 'switchSceneFile', id: 'main', requestId: expect.any(String) });
  });

  it('routes catalog defaults through the resilient scene switch path', () => {
    expect(sceneActivationToOp({
      ...base,
      provenance: 'catalog-default',
      mode: 'open-catalog',
      authoredSceneId: 'default',
      canEditInstance: false,
      canPromote: false,
    }, undefined, 'catalog-switch')).toEqual({
      kind: 'switchSceneFile',
      id: 'default',
      requestId: 'catalog-switch',
    });
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
