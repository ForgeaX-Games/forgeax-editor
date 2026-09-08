import { describe, expect, test } from 'bun:test';
import {
  createRuntimeGenerationHandoff,
  type RuntimeGenerationHandoff,
} from '../generation-handoff';

function makeHandoff(): RuntimeGenerationHandoff {
  return createRuntimeGenerationHandoff({
    initialGeneration: 8,
    initialProjectionLease: 'projection-g8',
    initialActionLease: 'action-g8',
  });
}

describe('Runtime generation handoff', () => {
  test('keeps the old run owner until the successor is cold-ready', async () => {
    const events: string[] = [];
    const handoff = makeHandoff();
    const run = handoff.begin({
      requestId: 'switch-request-1',
      receipt: {
        requestId: 'switch-request-1',
        targetTag: 'playtest/forest',
        targetCommit: 'commit-g9',
        repositoryIdentity: 'repo-1',
        detached: true,
        filesVerified: true,
      },
      teardown: async () => { events.push('teardown'); },
      bootSuccessor: async (generation) => {
        events.push(`boot:${generation}`);
        return {
          generation,
          projectionLease: 'projection-g9',
          actionLease: 'action-g9',
          repositoryIdentity: 'repo-1',
          targetCommit: 'commit-g9',
        };
      },
      terminal: (status) => { events.push(`terminal:${status}`); },
    });

    expect(handoff.snapshot().runOwner).toBe('switch-request-1');
    expect(handoff.snapshot().generation).toBe(8);
    expect(events).toEqual([]);
    const terminal = await run;
    expect(terminal).toMatchObject({ status: 'succeeded', generation: 9, requestId: 'switch-request-1' });
    expect(events).toEqual(['teardown', 'boot:9', 'terminal:succeeded']);
    expect(handoff.snapshot()).toMatchObject({
      generation: 9,
      projectionLease: 'projection-g9',
      actionLease: 'action-g9',
      runOwner: null,
    });
  });

  test('adopts a journal request when the old carrier disappears', async () => {
    const handoff = makeHandoff();
    const adopted = await handoff.adopt({
      requestId: 'switch-request-2',
      receipt: {
        requestId: 'switch-request-2',
        targetTag: 'playtest/desert',
        targetCommit: 'commit-g9',
        repositoryIdentity: 'repo-1',
        detached: true,
        filesVerified: true,
      },
      successor: {
        generation: 9,
        projectionLease: 'projection-g9',
        actionLease: 'action-g9',
        repositoryIdentity: 'repo-1',
        targetCommit: 'commit-g9',
      },
    });
    expect(adopted).toMatchObject({ status: 'succeeded', requestId: 'switch-request-2', generation: 9 });
    expect(handoff.snapshot().runOwner).toBeNull();
  });

  test('freezes on a successor identity mismatch and reports a terminal failure', async () => {
    const events: string[] = [];
    const handoff = makeHandoff();
    const result = await handoff.begin({
      requestId: 'switch-mismatch',
      receipt: {
        requestId: 'switch-mismatch', targetTag: 'playtest/bad', targetCommit: 'commit-g9',
        repositoryIdentity: 'repo-1', detached: true, filesVerified: true,
      },
      teardown: () => {},
      bootSuccessor: async (generation) => ({
        generation, projectionLease: 'projection-g9', actionLease: 'action-g9',
        repositoryIdentity: 'repo-other', targetCommit: 'commit-g9',
      }),
      terminal: (status) => events.push(status),
    });
    expect(result).toMatchObject({ status: 'failed', error: { code: 'version-control-generation-not-ready' } });
    expect(handoff.snapshot()).toMatchObject({ state: 'frozen', runOwner: 'switch-mismatch' });
    expect(events).toEqual(['failed']);
  });

  test('rejects a concurrent handoff while the first transition owns the run', async () => {
    let releaseTeardown!: () => void;
    const teardownGate = new Promise<void>((resolve) => { releaseTeardown = resolve; });
    const handoff = makeHandoff();
    const first = handoff.begin({
      requestId: 'switch-active',
      receipt: {
        requestId: 'switch-active', targetTag: 'playtest/active', targetCommit: 'commit-g9',
        repositoryIdentity: 'repo-1', detached: true, filesVerified: true,
      },
      teardown: () => teardownGate,
      bootSuccessor: async (generation) => ({
        generation, projectionLease: 'projection-g9', actionLease: 'action-g9',
        repositoryIdentity: 'repo-1', targetCommit: 'commit-g9',
      }),
      terminal: () => {},
    });
    await Promise.resolve();
    const second = await handoff.begin({
      requestId: 'switch-second',
      receipt: {
        requestId: 'switch-second', targetTag: 'playtest/second', targetCommit: 'commit-g10',
        repositoryIdentity: 'repo-1', detached: true, filesVerified: true,
      },
      teardown: () => {},
      bootSuccessor: async (generation) => ({
        generation, projectionLease: 'projection-g10', actionLease: 'action-g10',
        repositoryIdentity: 'repo-1', targetCommit: 'commit-g10',
      }),
      terminal: () => {},
    });
    expect(second).toMatchObject({ status: 'failed', error: { code: 'version-control-transition-active' } });
    releaseTeardown();
    await first;
  });

  test('rejects adopting a different request while a handoff is active', async () => {
    let releaseTeardown!: () => void;
    const teardownGate = new Promise<void>((resolve) => { releaseTeardown = resolve; });
    const handoff = makeHandoff();
    const first = handoff.begin({
      requestId: 'adopt-active',
      receipt: {
        requestId: 'adopt-active', targetTag: 'playtest/active', targetCommit: 'commit-g9',
        repositoryIdentity: 'repo-1', detached: true, filesVerified: true,
      },
      teardown: () => teardownGate,
      bootSuccessor: async (generation) => ({
        generation, projectionLease: 'projection-g9', actionLease: 'action-g9',
        repositoryIdentity: 'repo-1', targetCommit: 'commit-g9',
      }),
      terminal: () => {},
    });
    await Promise.resolve();
    const adopted = await handoff.adopt({
      requestId: 'adopt-other',
      receipt: {
        requestId: 'adopt-other', targetTag: 'playtest/other', targetCommit: 'commit-g9',
        repositoryIdentity: 'repo-1', detached: true, filesVerified: true,
      },
      successor: {
        generation: 9, projectionLease: 'projection-g9', actionLease: 'action-g9',
        repositoryIdentity: 'repo-1', targetCommit: 'commit-g9',
      },
    });
    expect(adopted).toMatchObject({ status: 'failed', error: { code: 'version-control-transition-active' } });
    releaseTeardown();
    await first;
  });

  test('freezes and reconciles only after an external inspection proves identity', () => {
    const handoff = makeHandoff();
    handoff.freeze('inspect repository');
    expect(handoff.snapshot()).toMatchObject({ state: 'frozen', runOwner: null });
    expect(handoff.reconcile('', null)).toBe(false);
    expect(handoff.snapshot().state).toBe('frozen');
    expect(handoff.reconcile('repo-1', 'commit-g9')).toBe(true);
    expect(handoff.snapshot()).toMatchObject({ state: 'ready', repositoryIdentity: 'repo-1', targetCommit: 'commit-g9' });
  });

  test('freezes and reports a structured failure when successor boot throws', async () => {
    const events: string[] = [];
    const handoff = makeHandoff();
    const result = await handoff.begin({
      requestId: 'switch-boot-failed',
      receipt: {
        requestId: 'switch-boot-failed', targetTag: 'playtest/fault', targetCommit: 'commit-g9',
        repositoryIdentity: 'repo-1', detached: true, filesVerified: true,
      },
      teardown: () => {},
      bootSuccessor: async () => { throw new Error('successor failed to boot'); },
      terminal: (status) => events.push(status),
    });
    expect(result).toMatchObject({ status: 'failed', error: { code: 'version-control-generation-handoff-failed', hint: 'successor failed to boot' } });
    expect(handoff.snapshot()).toMatchObject({ state: 'frozen', runOwner: 'switch-boot-failed' });
    expect(events).toEqual(['failed']);
  });
});
