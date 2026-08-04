import { describe, expect, test } from 'bun:test';
import {
  createSourceMutationPreflightCoordinator,
  type SourceMutationPreflightInput,
} from '../assets/source-mutation-preflight';

function input(): SourceMutationPreflightInput {
  return {
    browser: {
      assets: [{
        guid: 'guid:mesh',
        kind: 'mesh',
        name: 'Mesh',
        packageUrl: '/game/assets/mesh.glb',
        storagePackageUrl: '/game/assets/mesh.glb',
        sourcePath: 'assets/mesh.glb',
        sourceKey: 'source:mesh',
        revision: 'meta:r1',
        refs: [],
        relations: [],
      }],
      relations: [],
    },
    meta: {
      metaRevision: 'meta:r1',
      subAssets: [{ guid: 'guid:mesh', sourceKey: 'source:mesh' }],
    },
    activeSceneReferences: [],
  };
}

describe('source authoring entry errors', () => {
  const cases = [
    {
      name: 'missing source key',
      code: 'asset-source-key-missing',
      guid: 'guid:mesh',
      sourceKey: '',
      subject: { kind: 'asset-source', guid: 'guid:mesh' },
    },
    {
      name: 'unknown source key',
      code: 'asset-source-key-unknown',
      guid: 'guid:mesh',
      sourceKey: 'source:missing',
      subject: { kind: 'asset-source', guid: 'guid:mesh', sourceKey: 'source:missing' },
    },
    {
      name: 'ambiguous source identity',
      code: 'asset-source-key-ambiguous',
      guid: 'guid:other',
      sourceKey: 'source:mesh',
      subject: { kind: 'asset-source', guid: 'guid:other', sourceKey: 'source:mesh' },
    },
  ] as const;

  for (const scenario of cases) {
    test(`returns a structured entry error for ${scenario.name}`, () => {
      const coordinator = createSourceMutationPreflightCoordinator(input());
      const result = coordinator.preflight({
        intent: 'save-asset-source-override',
        operationId: `op-${scenario.name.replaceAll(' ', '-')}`,
        requestId: `req-${scenario.name.replaceAll(' ', '-')}`,
        guid: scenario.guid,
        scope: { sourceKey: scenario.sourceKey },
        expectedRevision: 'meta:r1',
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: scenario.code,
          phase: 'entry',
          subjectRef: scenario.subject,
          recoveryActions: ['asset.preflight'],
          retryable: false,
        },
      });
      expect(result).not.toHaveProperty('error.path');
      expect(result).not.toHaveProperty('error.message');
    });
  }
});
