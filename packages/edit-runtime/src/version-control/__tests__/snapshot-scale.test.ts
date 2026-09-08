import { describe, expect, test } from 'bun:test';
import {
  createVersionControlSnapshotEnvelope,
  type VersionControlSnapshot,
} from '@forgeax/editor-core';
import { VersionControlSnapshotClient } from '@forgeax/editor-core';

function readySnapshot(generation: number): VersionControlSnapshot {
  return {
    generation,
    status: 'ready',
    repositoryIdentity: 'repo:/scale-game',
    head: 'f'.repeat(40),
    currentTag: 'scale-999',
    snapshotId: `scale-${generation}`,
    dirtyRecords: [],
    graph: {
      nodes: Array.from({ length: 1000 }, (_, index) => ({ id: `scale-${index}`, head: `${index.toString(16).padStart(40, '0')}` })),
      edges: Array.from({ length: 999 }, (_, index) => ({ from: `scale-${index + 1}`, to: `scale-${index}` })),
    },
  };
}

describe('version-control snapshot projection scale', () => {
  test('round-trips 1k graph nodes without losing generation or identity', () => {
    const client = new VersionControlSnapshotClient(9);
    const snapshot = readySnapshot(9);
    const elapsed: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const start = performance.now();
      const envelope = createVersionControlSnapshotEnvelope(snapshot);
      client.publish(envelope.snapshot);
      elapsed.push(performance.now() - start);
      const current = client.read();
      expect(current.status).toBe('ready');
      if (current.status !== 'ready') return;
      expect(current.generation).toBe(9);
      expect(current.repositoryIdentity).toBe('repo:/scale-game');
      expect(current.graph.nodes).toHaveLength(1000);
      expect(current.graph.edges).toHaveLength(999);
    }
    expect(Math.max(...elapsed)).toBeLessThan(5000);
  });
});
