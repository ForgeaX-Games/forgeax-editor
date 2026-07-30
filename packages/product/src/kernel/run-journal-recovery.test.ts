import { expect, test } from 'bun:test';

import { RunJournal } from './run-journal';

test('a malformed record is isolated while healthy records remain queryable', () => {
  const journal = RunJournal.fromRecords({
    scope: 'game-1',
    records: [
      {
        type: 'accepted',
        runId: 'run-1',
        sequence: 1,
        at: 1,
        operationId: 'asset.create',
        actor: { id: 'agent-1', kind: 'ai' },
        sessionId: 'session-1',
        scope: 'game-1',
        input: {},
        idempotencyKey: 'key-1',
      },
      { type: 'corrupt', runId: 'bad', sequence: 2, at: 2 } as never,
    ],
    now: () => 3,
  });
  expect(journal.getRun('run-1')).toMatchObject({ status: 'accepted' });
  expect(journal.diagnostics()).toMatchObject({ isolatedRecords: 1 });
  expect(journal.listRecords()).toHaveLength(1);
});

test('the trace ring is not required to rebuild the journal index', () => {
  const journal = new RunJournal({ scope: 'game-1', now: () => 1 });
  expect(journal.accept({
    runId: 'run-1',
    operationId: 'asset.create',
    actor: { id: 'agent-1', kind: 'ai' },
    sessionId: 'session-1',
    scope: 'game-1',
    input: {},
    idempotencyKey: 'key-1',
  })).toMatchObject({ ok: true });
  const records = journal.listRecords();
  expect(records.every((record) => !('traceRing' in record) && !('promiseCache' in record))).toBe(true);
  const restarted = RunJournal.fromRecords({ scope: 'game-1', records, now: () => 2 });
  expect(restarted.getRun('run-1')).toMatchObject({ runId: 'run-1', status: 'accepted' });
});
