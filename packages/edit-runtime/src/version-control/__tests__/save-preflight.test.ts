import { describe, expect, test } from 'bun:test';
import { createOperationRun } from '@forgeax/editor-product';
import {
  createSavePreflight,
  type SavePreflightSnapshot,
} from '../save-preflight';

function run(status: 'accepted' | 'running' | 'succeeded' | 'failed') {
  const created = createOperationRun({
    runId: 'run-save',
    requestId: 'save-1',
    operationId: 'saveDocToDisk',
    input: { kind: 'saveDocToDisk', requestId: 'save-1' },
    actor: { id: 'human', kind: 'human' },
    sessionId: 'editor-panel',
    scope: 'viewport:test:1',
    cancellable: false,
    retryable: true,
  } as never, 1);
  if (!created.ok) throw new Error('unable to build save run');
  return { ...created.value, status } as never;
}

const snapshot = (snapshotId: string): SavePreflightSnapshot => ({
  repositoryIdentity: 'repo:/game',
  head: 'head-1',
  snapshotId,
  dirtyRecords: [],
});

describe('version control save preflight', () => {
  test('reads Git status only after save terminal success', async () => {
    let reads = 0;
    const result = await createSavePreflight({
      saveRun: run('succeeded'),
      expectedSnapshotId: 'snap-1',
      readSnapshot: async () => { reads += 1; return snapshot('snap-1'); },
    });
    expect(result.ok).toBe(true);
    expect(reads).toBe(1);
  });

  test('does not read or publish a new snapshot for accepted/running/failed saves', async () => {
    for (const status of ['accepted', 'running', 'failed'] as const) {
      let reads = 0;
      const result = await createSavePreflight({
        saveRun: run(status),
        expectedSnapshotId: 'snap-1',
        readSnapshot: async () => { reads += 1; return snapshot('snap-1'); },
      });
      expect(result.ok).toBe(false);
      expect(reads).toBe(0);
    }
  });

  test('returns stale when the post-save repository snapshot changes', async () => {
    const result = await createSavePreflight({
      saveRun: run('succeeded'),
      expectedSnapshotId: 'snap-1',
      readSnapshot: async () => snapshot('snap-2'),
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'version-control-snapshot-stale' } });
  });
});
