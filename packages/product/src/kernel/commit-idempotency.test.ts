import { describe, expect, test } from 'bun:test';

import { CommitCollar } from './commit-collar';

const base = (runId: string, input: unknown) => ({
  operationId: 'asset.create',
  input,
  run: {
    runId,
    actor: { id: 'ai-1', kind: 'ai' as const },
    sessionId: 'session-1',
    scope: 'game-1',
    idempotencyKey: 'commit-key',
  },
  effect: { commit: async () => ({ revision: 'revision-1', result: input, inverse: { kind: 'asset.destroy' } }) },
});

describe('commit idempotency', () => {
  test('equivalent retries reuse one run and one authored effect', async () => {
    let effects = 0;
    let published = 0;
    const collar = new CommitCollar();
    const first = await collar.dispatch({
      ...base('run-1', { guid: 'asset-1' }),
      effect: { commit: async () => { effects += 1; return { revision: 'revision-1', result: 'created' }; } },
      authored: { publish: async () => { published += 1; } },
    });
    const second = await collar.dispatch({
      ...base('run-2', { guid: 'asset-1' }),
      authored: { publish: async () => { published += 1; } },
    });

    expect(first).toMatchObject({ ok: true, runId: 'run-1', reused: false });
    expect(second).toMatchObject({ ok: true, runId: 'run-1', reused: true });
    expect(effects).toBe(1);
    expect(published).toBe(1);
  });

  test('different payloads and repeated inverse keys fail without a second effect', async () => {
    const collar = new CommitCollar();
    const authored: string[] = [];
    const first = await collar.dispatch({
      ...base('run-1', { guid: 'asset-1' }),
      authored: { publish: async (entry) => { authored.push(entry.operationId); } },
    });
    expect(first).toMatchObject({ ok: true });
    const conflict = await collar.dispatch({
      ...base('run-2', { guid: 'asset-2' }),
      authored: { publish: async (entry) => { authored.push(entry.operationId); } },
    });
    expect(conflict).toMatchObject({ ok: false, error: { code: 'idempotency-conflict' } });
    expect(authored).toEqual(['asset.create']);
  });
});
