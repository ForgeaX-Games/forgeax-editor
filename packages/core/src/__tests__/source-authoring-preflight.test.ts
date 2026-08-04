import { describe, expect, test } from 'bun:test';
import {
  createSourceMutationPreflightCoordinator,
  type SourceMutationPreflightInput,
} from '../assets/source-mutation-preflight';

const snapshot: SourceMutationPreflightInput = {
  browser: {
    assets: [
      {
        guid: 'guid:mesh-a',
        kind: 'mesh',
        name: 'Mesh A',
        packageUrl: '/game/assets/mesh.glb',
        storagePackageUrl: '/game/assets/mesh.glb',
        sourcePath: 'assets/mesh.glb',
        sourceKey: 'source:mesh',
        revision: 'meta:r7',
        refs: [],
        relations: [],
      },
      {
        guid: 'guid:mesh-b',
        kind: 'mesh',
        name: 'Mesh B',
        packageUrl: '/game/assets/mesh.glb',
        storagePackageUrl: '/game/assets/mesh.glb',
        sourcePath: 'assets/mesh.glb',
        sourceKey: 'source:mesh',
        revision: 'meta:r7',
        refs: [],
        relations: [],
      },
    ],
    relations: [],
  },
  meta: {
    metaRevision: 'meta:r7',
    subAssets: [
      { guid: 'guid:mesh-a', sourceKey: 'source:mesh' },
      { guid: 'guid:mesh-b', sourceKey: 'source:mesh' },
    ],
  },
  activeSceneReferences: [],
};

describe('source authoring preflight', () => {
  test('keeps source scope explicit and returns the selected impact', () => {
    const result = createSourceMutationPreflightCoordinator(snapshot).preflight({
      intent: 'save-asset-source-override',
      operationId: 'op-scope',
      requestId: 'req-scope',
      guid: 'guid:mesh-a',
      scope: { sourceKey: 'source:mesh' },
      expectedRevision: 'meta:r7',
    });

    expect(result).toMatchObject({
      ok: true,
      preflight: {
        scope: { sourceKey: 'source:mesh' },
        expectedRevision: 'meta:r7',
        affectedGuids: ['guid:mesh-a', 'guid:mesh-b'],
      },
    });
  });

  test('rejects a stale revision before any producer or Meta write can run', () => {
    const result = createSourceMutationPreflightCoordinator(snapshot).preflight({
      intent: 'save-asset-source-override',
      operationId: 'op-stale',
      requestId: 'req-stale',
      guid: 'guid:mesh-a',
      scope: { sourceKey: 'source:mesh' },
      expectedRevision: 'meta:r6',
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'asset-meta-revision-conflict',
        expected: 'meta:r6',
        actual: 'meta:r7',
      },
    });
  });
});
