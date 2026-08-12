import { describe, expect, test } from 'bun:test';

import { CommitCollar } from '../commit-collar';

const run = (runId: string, operationId: string) => ({
  runId,
  operationId,
  actor: { id: 'human-1', kind: 'human' as const },
  sessionId: 'session-1',
  scope: 'game-1',
});

describe('undo and redo runs', () => {
  test('immediate undo and redo each finish as their own terminal run', async () => {
    const revisions: [string, string, string] = ['revision-1', 'revision-2', 'revision-3'];
    const collar = new CommitCollar();
    const authored: string[] = [];
    const committed = await collar.dispatch({
      operationId: 'asset.rename',
      input: { name: 'new' },
      run: run('run-commit', 'asset.rename'),
      effect: { commit: async () => ({ revision: revisions[0]!, result: { name: 'new' }, inverse: { name: 'old' } }) },
      authored: { publish: async (entry) => { authored.push(entry.operationId); } },
    });
    expect(committed).toMatchObject({ ok: true });

    const undone = await collar.undo({
      sourceRunId: 'run-commit',
      expectedRevision: revisions[0],
      run: run('run-undo', 'asset.rename.undo'),
      effect: { commit: async (context) => ({ revision: revisions[1]!, result: context.input, inverse: { name: 'new' } }) },
      authored: { publish: async (entry) => { authored.push(entry.operationId); } },
    });
    expect(undone).toMatchObject({ ok: true, runId: 'run-undo' });

    const redone = await collar.redo({
      sourceRunId: 'run-commit',
      expectedRevision: revisions[1],
      run: run('run-redo', 'asset.rename.redo'),
      effect: { commit: async (context) => ({ revision: revisions[2]!, result: context.input, inverse: { name: 'old' } }) },
      authored: { publish: async (entry) => { authored.push(entry.operationId); } },
    });
    expect(redone).toMatchObject({ ok: true, runId: 'run-redo' });
    expect(authored).toEqual(['asset.rename', 'asset.rename.undo', 'asset.rename.redo']);
    expect(collar.getRun('run-undo')).toMatchObject({ status: 'succeeded' });
    expect(collar.getRun('run-redo')).toMatchObject({ status: 'succeeded' });
  });

  test('a revision conflict fails undo without publishing another authored entry', async () => {
    let published = 0;
    const collar = new CommitCollar();
    await collar.dispatch({
      operationId: 'asset.rename',
      input: { name: 'new' },
      run: run('run-commit', 'asset.rename'),
      effect: { commit: async () => ({ revision: 'revision-1', result: null, inverse: { name: 'old' } }) },
      authored: { publish: async () => { published += 1; } },
    });
    const failed = await collar.undo({
      sourceRunId: 'run-commit',
      expectedRevision: 'stale-revision',
      run: run('run-undo-failed', 'asset.rename.undo'),
      effect: { commit: async () => ({ revision: 'never', result: null }) },
      authored: { publish: async () => { published += 1; } },
    });
    expect(failed).toMatchObject({ ok: false, error: { code: 'revision-conflict' } });
    expect(published).toBe(1);
  });
});
