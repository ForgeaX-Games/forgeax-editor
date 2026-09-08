import { expect, test } from 'bun:test';
import { type VersionControlSnapshot } from '@forgeax/editor-core';
import { saveAndVerifyDurableVersionControl, verifyDurableVersionControlSave } from '../provider';

const snapshot = (head: string): VersionControlSnapshot => ({
  generation: 7,
  status: 'ready',
  repositoryIdentity: 'repo-gta',
  head,
  currentTag: null,
  snapshotId: `snapshot-${head}`,
  dirtyRecords: [],
  graph: { nodes: [], edges: [] },
});

test('version-control Save is clean only after a newly created reader sees the same snapshot', async () => {
  const result = await verifyDurableVersionControlSave({
    requestId: 'save-provider-1',
    writerRealmId: 'writer-realm',
    authoritative: snapshot('head-2'),
    createFreshReader: async () => ({ realmId: 'reader-realm', readSnapshot: async () => snapshot('head-2') }),
  });

  expect(result).toMatchObject({ state: 'clean', readerRealmId: 'reader-realm' });
});

test('version-control Save remains dirty or unknown on mismatch and read failure', async () => {
  await expect(verifyDurableVersionControlSave({
    requestId: 'save-provider-2',
    writerRealmId: 'writer-realm',
    authoritative: snapshot('head-2'),
    createFreshReader: async () => ({ realmId: 'reader-realm', readSnapshot: async () => snapshot('head-1') }),
  })).resolves.toMatchObject({ state: 'dirty', error: { code: 'durability-mismatch' } });

  await expect(verifyDurableVersionControlSave({
    requestId: 'save-provider-3',
    writerRealmId: 'writer-realm',
    authoritative: snapshot('head-2'),
    createFreshReader: async () => ({ realmId: 'reader-realm', readSnapshot: async () => { throw new Error('network'); } }),
  })).resolves.toMatchObject({ state: 'unknown', error: { code: 'read-back-failed' } });
});

test('version-control Save preserves unknown state when the Host write fails', async () => {
  await expect(saveAndVerifyDurableVersionControl({
    requestId: 'save-provider-4',
    writerRealmId: 'writer-realm',
    save: async () => { throw new Error('host unavailable'); },
    createFreshReader: async () => ({ realmId: 'reader-realm', readSnapshot: async () => snapshot('head-2') }),
  })).resolves.toMatchObject({ state: 'unknown', error: { code: 'save-failed' } });
});
