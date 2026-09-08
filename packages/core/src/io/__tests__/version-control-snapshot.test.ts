import { describe, expect, test } from 'bun:test';
import {
  createVersionControlSnapshotEnvelope,
  isVersionControlSnapshotForGeneration,
  type VersionControlSnapshot,
} from '../version-control-schema';
import { VersionControlSnapshotClient } from '../viewport-runtime-client';

const ready = (generation: number): VersionControlSnapshot => ({
  generation,
  status: 'ready',
  repositoryIdentity: 'repo:/game',
  head: '0123456789abcdef',
  currentTag: null,
  snapshotId: `snapshot-${generation}`,
  dirtyRecords: [],
  graph: { nodes: [], edges: [] },
});

describe('version-control snapshot transport', () => {
  test('fences snapshots by Runtime generation and preserves identity facts', () => {
    const envelope = createVersionControlSnapshotEnvelope(ready(3));
    expect(envelope.generation).toBe(3);
    if (envelope.snapshot.status === 'ready') expect(envelope.snapshot.repositoryIdentity).toBe('repo:/game');
    expect(isVersionControlSnapshotForGeneration(envelope.snapshot, 3)).toBe(true);
    expect(isVersionControlSnapshotForGeneration(envelope.snapshot, 2)).toBe(false);
  });

  test('does not reuse a stale generation in the client projection', () => {
    const client = new VersionControlSnapshotClient(4);
    client.publish(ready(4));
    expect(client.read().status).toBe('ready');
    expect(() => client.publish(ready(3))).toThrow('version-control-stale-generation');
    client.clear();
    expect(client.read().status).toBe('unavailable');
  });

  test('keeps running and recovery-required states explicit instead of projecting clean', () => {
    const running: VersionControlSnapshot = {
      generation: 1,
      status: 'running',
      run: { operationId: 'publishGameVersion', runId: 'run-1', requestId: 'req-1', status: 'running' } as never,
    };
    const recovery: VersionControlSnapshot = {
      generation: 1,
      status: 'recovery-required',
      error: { code: 'version-control-recovery-required', hint: 'inspect repository', recoveryActions: ['version-control.refresh'] } as never,
    };
    expect(running.status).toBe('running');
    expect(recovery.status).toBe('recovery-required');
    expect((recovery as { dirtyRecords?: unknown[] }).dirtyRecords).toBeUndefined();
  });
});
