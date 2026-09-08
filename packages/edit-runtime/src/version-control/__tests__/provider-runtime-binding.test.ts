import { describe, expect, test } from 'bun:test';
import {
  GatewayWriteBarrier,
  gateway,
  type EditGateway,
} from '@forgeax/editor-core';
import { createSwitchHandoff } from '../switch-applier';
import {
  createVersionControlHostPort,
  createVersionControlRuntimeBinding,
} from '../provider';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function readySnapshot(generation: number) {
  return {
    generation,
    status: 'ready',
    repositoryIdentity: 'repo-1',
    head: 'commit-g8',
    currentTag: 'playtest/forest',
    snapshotId: 'snapshot-1',
    dirtyRecords: [],
    graph: { nodes: [], edges: [] },
  } as const;
}

describe('version-control runtime binding', () => {
  test('scopes HostPort requests and never serializes client cwd or argv', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const host = createVersionControlHostPort({
      gameRoot: '/host/authoritative/game',
      generation: 8,
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return url.toString().endsWith('/snapshot')
          ? response(readySnapshot(8))
          : response({ ok: true, receipt: { requestId: 'r1', targetTag: 'playtest/forest', targetCommit: 'commit-g9', repositoryIdentity: 'repo-1', detached: true, filesVerified: true } });
      },
    });

    expect(host.gameRoot).toBe('/host/authoritative/game');
    await host.readSnapshot();
    await host.runCommand('switchGameVersion', { requestId: 'r1', tag: 'playtest/forest', expectedCommit: 'commit-g9' });
    expect(requests.map((request) => request.url)).toEqual([
      '/api/version-control/snapshot',
      '/api/version-control/commands/switchGameVersion',
    ]);
    const body = requests[1]?.init?.body as string;
    expect(body).not.toContain('cwd');
    expect(body).not.toContain('argv');
    expect(body).not.toContain('kind');
    expect(body).not.toContain('/host/authoritative/game');
  });

  test('preserves an uninitialized snapshot returned with the Host warning status', async () => {
    const host = createVersionControlHostPort({
      gameRoot: '/host/game',
      generation: 8,
      fetch: async (url) => url.toString().endsWith('/snapshot')
        ? response({
          generation: 8,
          status: 'uninitialized',
          error: { code: 'version-control-unavailable', hint: 'Initialize the current game repository' },
        }, 503)
        : response({ ok: true }),
    });

    await expect(host.readSnapshot()).resolves.toMatchObject({ generation: 8, status: 'uninitialized' });
  });

  test('preserves the complete structured CommandError across the Host boundary', async () => {
    const host = createVersionControlHostPort({
      gameRoot: '/host/game',
      generation: 8,
      fetch: async () => response({
        error: {
          code: 'version-control-target-stale',
          hint: 'The selected target moved.',
          stage: 'checkout-cas',
          expected: { commit: 'commit-old' },
          actual: { commit: 'commit-new' },
          requestId: 'request-structured',
          commitIdentity: 'repo-1',
          recoveryActions: ['version-control.refresh', 'run.retry'],
          cause: { code: 'latest-conflict', details: { ref: 'refs/forgeax/latest' } },
          retryable: false,
        },
      }, 409),
    });

    await expect(host.runCommand('switchGameVersion', { requestId: 'request-structured' })).rejects.toMatchObject({
      code: 'version-control-target-stale',
      hint: 'The selected target moved.',
      stage: 'checkout-cas',
      expected: { commit: 'commit-old' },
      actual: { commit: 'commit-new' },
      requestId: 'request-structured',
      commitIdentity: 'repo-1',
      recoveryActions: ['version-control.refresh', 'run.retry'],
      cause: { code: 'latest-conflict' },
      retryable: false,
      status: 409,
    });
  });

  test('installs one live catalog/applier set and refreshes its shared snapshot', async () => {
    const host = createVersionControlHostPort({
      gameRoot: '/host/game',
      generation: 8,
      fetch: async () => response(readySnapshot(8)),
    });
    const binding = createVersionControlRuntimeBinding({ gateway, generation: 8, host });
    try {
      expect(gateway.listOps().filter((entry) => entry.id === 'switchGameVersion')).toHaveLength(1);
      expect(gateway.listOps().find((entry) => entry.id === 'switchGameVersion')).toMatchObject({
        confirmation: { required: true },
        operationRun: { retry: { requiresNewRequestId: true }, cancellable: false },
        recoveryActions: ['version-control.refresh', 'run.wait', 'run.retry'],
      });
      await binding.provider.refresh();
      expect(binding.provider.snapshot()).toMatchObject({ status: 'ready', generation: 8, repositoryIdentity: 'repo-1' });
    } finally {
      binding.dispose();
    }
  });

  test('dispatches switch through the existing barrier and commits a cold-ready successor', async () => {
    const barrier = new GatewayWriteBarrier();
    const handoff = createSwitchHandoff({ generation: 8, projectionLease: 'projection-g8', actionLease: 'action-g8', repositoryIdentity: 'repo-1' });
    const events: string[] = [];
    const host = createVersionControlHostPort({
      gameRoot: '/host/game',
      generation: 8,
      fetch: async (url) => url.toString().endsWith('/snapshot')
        ? response(readySnapshot(8))
        : response({ ok: true, value: { requestId: 'r2', targetTag: 'playtest/desert', targetCommit: 'commit-g9', repositoryIdentity: 'repo-1', detached: true, filesVerified: true } }),
    });
    const binding = createVersionControlRuntimeBinding({
      gateway: gateway as EditGateway,
      generation: 8,
      host,
      transition: {
        barrier,
        handoff,
        readPreflight: () => ({ playActive: false, stagingActive: false, dirty: false, untracked: false, targetDrifted: false, writeOperationActive: false, rootMatches: true, repositoryRecoveryRequired: false, generation: 8 }),
        teardown: () => { events.push('teardown'); },
        bootSuccessor: async (generation) => { events.push('cold-ready'); return { generation, projectionLease: 'projection-g9', actionLease: 'action-g9', repositoryIdentity: 'repo-1', targetCommit: 'commit-g9' }; },
        terminal: (status) => { events.push(`terminal:${status}`); },
        committed: () => { events.push('committed'); },
      },
    });
    try {
      const result = await binding.provider.dispatch('switchGameVersion', { requestId: 'r2', tag: 'playtest/desert', expectedCommit: 'commit-g9' });
      expect(result).toMatchObject({ status: 'succeeded', generation: 9 });
      expect(events).toEqual(['teardown', 'cold-ready', 'terminal:succeeded', 'committed']);
      expect(barrier.snapshot().phase).toBe('open');
      expect(binding.provider.snapshot().generation).toBe(8);
    } finally {
      binding.dispose();
    }
  });

  test('freezes the Gateway when successor readiness is uncertain', async () => {
    const barrier = new GatewayWriteBarrier();
    const handoff = createSwitchHandoff({ generation: 8, projectionLease: 'projection-g8', actionLease: 'action-g8', repositoryIdentity: 'repo-1' });
    const host = createVersionControlHostPort({
      gameRoot: '/host/game',
      generation: 8,
      fetch: async (url) => url.toString().endsWith('/snapshot')
        ? response(readySnapshot(8))
        : response({ ok: true, receipt: { requestId: 'r3', targetTag: 'playtest/fail', targetCommit: 'commit-g9', repositoryIdentity: 'repo-1', detached: true, filesVerified: true } }),
    });
    const binding = createVersionControlRuntimeBinding({
      gateway,
      generation: 8,
      host,
      transition: {
        barrier,
        handoff,
        readPreflight: () => ({ playActive: false, stagingActive: false, dirty: false, untracked: false, targetDrifted: false, writeOperationActive: false, rootMatches: true, repositoryRecoveryRequired: false, generation: 8 }),
        teardown: () => {},
        bootSuccessor: async () => { throw new Error('successor cold boot failed'); },
        terminal: () => {},
      },
    });
    try {
      const result = await binding.provider.dispatch('switchGameVersion', { requestId: 'r3', tag: 'playtest/fail', expectedCommit: 'commit-g9' });
      expect(result).toMatchObject({ status: 'failed' });
      expect(barrier.snapshot()).toMatchObject({ phase: 'frozen' });
    } finally {
      binding.dispose();
    }
  });
});
