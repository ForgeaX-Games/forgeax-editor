import { describe, expect, test } from 'bun:test';

import { CommitCollar } from './commit-collar';

function request(runId: string, resources: { prepare: () => Promise<{ commit: () => Promise<{ revision: string }> }> }) {
  return {
    operationId: 'asset.write',
    input: { first: 'a', second: 'b' },
    run: {
      runId,
      actor: { id: 'worker-1', kind: 'system' as const },
      sessionId: 'session-1',
      scope: 'game-1',
    },
    resources,
    effect: { commit: async () => ({ revision: 'canonical-revision', result: { ok: true } }) },
  };
}

describe('resource failure injection', () => {
  test('a second-resource failure publishes neither an authored effect nor a half-success', async () => {
    const writes: string[] = [];
    let published = 0;
    const collar = new CommitCollar();
    const result = await collar.dispatch({
      ...request('run-second-resource-failure', {
        prepare: async () => ({
          commit: async () => {
            writes.push('resource-a');
            throw new Error('resource-b failed');
          },
        }),
      }),
      authored: { publish: async () => { published += 1; } },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'commit-collar-failed' } });
    expect(writes).toEqual(['resource-a']);
    expect(published).toBe(0);
  });

  test('an interrupted commit can be retried with a fresh run without duplicating authored history', async () => {
    let attempts = 0;
    let published = 0;
    const collar = new CommitCollar();
    const resources = {
      prepare: async () => ({
        commit: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('process interrupted');
          return { revision: 'resource-revision-2' };
        },
      }),
    };
    const first = await collar.dispatch({
      ...request('run-interrupted', resources),
      authored: { publish: async () => { published += 1; } },
    });
    const second = await collar.dispatch({
      ...request('run-retry', resources),
      run: { ...request('run-retry', resources).run, idempotencyKey: 'retry-1' },
      authored: { publish: async () => { published += 1; } },
    });

    expect(first).toMatchObject({ ok: false });
    expect(second).toMatchObject({ ok: true });
    expect(attempts).toBe(2);
    expect(published).toBe(1);
  });
});
