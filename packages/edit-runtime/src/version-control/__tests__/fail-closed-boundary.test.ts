import { expect, test } from 'bun:test';
import type { VersionControlSnapshot } from '@forgeax/editor-core';
import { createVersionControlHostPort } from '../provider';

const snapshot: VersionControlSnapshot = {
  generation: 2,
  status: 'ready',
  repositoryIdentity: 'repo-gta',
  head: 'head-2',
  currentTag: null,
  snapshotId: 'snapshot-2',
  dirtyRecords: [],
  graph: { nodes: [], edges: [] },
};

test('does not serialize the Host-only game root into a public command request', async () => {
  let body: string | undefined;
  const host = createVersionControlHostPort({
    gameRoot: '/private/game-root',
    generation: 2,
    fetch: async (_input, init) => {
      body = typeof init?.body === 'string' ? init.body : undefined;
      return Response.json(snapshot);
    },
  });

  await host.runCommand('initializeGameRepository', { requestId: 'save-1' });

  expect(body).toBe('{"requestId":"save-1"}');
  expect(body).not.toContain('gameRoot');
  expect(body).not.toContain('/private/game-root');
});
