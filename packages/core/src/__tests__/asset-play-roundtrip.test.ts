import { describe, expect, test } from 'bun:test';
import {
  createAssetSubject,
  createAssetWorkspaceSnapshot,
} from '@forgeax/editor-product';
import { createAssetMutationSafetyAdapter } from '../product/asset-producer-adapter';

describe('asset Edit to Play roundtrip', () => {
  test('keeps authored subject facts stable across commit, reopen, and Play snapshots', async () => {
    const initial = createAssetWorkspaceSnapshot({
      revision: 'workspace:r1',
      resourceRevision: 'resource:r1',
      subjects: [
        createAssetSubject({
          id: 'asset:material',
          kind: 'internal-asset',
          provenance: { owner: 'engine', source: 'producer-catalog' },
          resourceId: 'resource:material',
          path: 'assets/material.pack.json',
          capabilities: { canImport: false, canMove: true, canDelete: true, canPreflight: true },
        }),
      ],
      relations: [],
      issues: [],
    });
    const adapter = createAssetMutationSafetyAdapter({
      snapshot: initial,
      commit: async () => ({ revision: 'resource:r2' }),
    });
    const preflight = adapter.preflight({ operation: 'replace', subjectId: 'asset:material' });
    const result = await adapter.run({
      operation: 'replace',
      subjectId: 'asset:material',
      expectedRevision: preflight.currentRevision,
      confirmationToken: preflight.confirmation.token,
    });

    expect(result.ok).toBe(true);
    expect(result.snapshot.subjects[0]?.id).toBe('asset:material');
    expect(result.snapshot.subjects[0]?.kind).toBe('internal-asset');
    expect(result.playSnapshot.subjects).toEqual(result.snapshot.subjects);
    expect(result.playSnapshot.relations).toEqual(result.snapshot.relations);
  });
});
