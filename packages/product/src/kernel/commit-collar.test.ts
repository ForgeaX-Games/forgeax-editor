import { describe, expect, test } from 'bun:test';

import { CommitCollar } from './commit-collar';

describe('commit collar ordering', () => {
  test('publishes authored history only after the canonical effect commits', async () => {
    const journal: string[] = [];
    const collar = new CommitCollar({
      now: () => 1,
      onEvent: (event) => journal.push(event.phase),
    });

    const result = await collar.dispatch({
      operationId: 'asset.rename',
      input: { guid: 'asset-1', name: 'Renamed' },
      run: {
        runId: 'run-1',
        actor: { id: 'human-1', kind: 'human' },
        sessionId: 'session-1',
        scope: 'game-1',
      },
      resources: {
        prepare: async () => ({
          commit: async () => {
            journal.push('resource-effect');
            return { revision: 'resource-rev-1' };
          },
        }),
      },
      effect: {
        commit: async () => {
          journal.push('canonical-effect');
          return { revision: 'canonical-rev-1', result: { ok: true }, inverse: { kind: 'asset.rename.undo' } };
        },
      },
      authored: {
        publish: async () => {
          journal.push('authored-publish');
        },
      },
    });

    expect(result).toMatchObject({ ok: true, runId: 'run-1' });
    expect(journal).toEqual([
      'prepare',
      'resource-effect',
      'resource-committed',
      'canonical-effect',
      'effect-committed',
      'authored-publish',
      'authored-published',
    ]);
  });

  test('a failed resource prepare has no authored history event', async () => {
    const events: string[] = [];
    let published = 0;
    const collar = new CommitCollar({ onEvent: (event) => events.push(event.phase) });

    const result = await collar.dispatch({
      operationId: 'asset.rename',
      input: { guid: 'asset-1' },
      run: {
        runId: 'run-2',
        actor: { id: 'ai-1', kind: 'ai' },
        sessionId: 'session-1',
        scope: 'game-1',
      },
      resources: {
        prepare: async () => {
          throw new Error('resource prepare failed');
        },
      },
      effect: { commit: async () => ({ revision: 'never', result: null }) },
      authored: { publish: async () => { published += 1; } },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'commit-collar-failed' } });
    expect(events).toEqual(['prepare', 'failed']);
    expect(published).toBe(0);
  });
});
