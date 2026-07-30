import { describe, expect, test } from 'bun:test';
import { createAssetMutationSafetyAdapter } from '../product/asset-producer-adapter';

describe('core reimport topology roundtrip', () => {
  test('uses producer identity and never silently rebinds by source index', () => {
    const adapter = createAssetMutationSafetyAdapter({
      snapshot: {
        schemaVersion: 'asset-workspace/v1',
        revision: 'workspace:r1',
        resourceRevision: 'resource:r1',
        identity: 'workspace-snapshot:test',
        subjects: [],
        relations: [],
        issues: [],
      },
      commit: async () => ({ revision: 'resource:r2' }),
    });

    const result = adapter.reimportTopology({
      previous: [{ subjectId: 'subject:mesh', producerIdentity: undefined, kind: 'mesh', sourceIndex: 0 }],
      next: [
        { subjectId: 'output:left', producerIdentity: undefined, kind: 'mesh', sourceIndex: 0 },
        { subjectId: 'output:right', producerIdentity: undefined, kind: 'mesh', sourceIndex: 0 },
      ],
      references: [{ referenceId: 'reference:mesh', subjectId: 'subject:mesh' }],
    });

    expect(result.status).toBe('ambiguous');
    expect(result.preservedReferences[0]?.subjectId).toBe('subject:mesh');
  });
});
