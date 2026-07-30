import { expect, test } from 'bun:test';

import { RunJournal } from './run-journal';

test('the first external effect result is append-only and survives journal/index rebuild', () => {
  const journal = new RunJournal({ scope: 'game-1' });
  expect(journal.accept({ runId: 'run-effect', operationId: 'asset.write', actor: { id: 'ai', kind: 'ai' }, sessionId: 's', scope: 'game-1', input: { id: 'asset:one' } })).toMatchObject({ ok: true });
  expect(journal.append({ type: 'running', runId: 'run-effect', at: 2 })).toMatchObject({ ok: true });
  expect(journal.append({ type: 'effect-result', runId: 'run-effect', at: 3, effectKey: 'effect:one', result: { revision: 'r1' } })).toMatchObject({ ok: true });
  expect(journal.append({ type: 'succeeded', runId: 'run-effect', at: 4, result: { revision: 'r1' } })).toMatchObject({ ok: true });
  const restarted = RunJournal.fromRecords({ scope: 'game-1', records: journal.listRecords() });
  expect(restarted.getEffectResult('effect:one')).toEqual({ runId: 'run-effect', result: { revision: 'r1' } });
  expect(restarted.listRecords().map((record) => record.type)).toEqual(['accepted', 'running', 'effect-result', 'succeeded']);
});

test('a retry has a new attempt and does not overwrite the failed child history', () => {
  const journal = new RunJournal({ scope: 'game-1' });
  expect(journal.accept({ runId: 'failed-1', operationId: 'asset.write', actor: { id: 'ai', kind: 'ai' }, sessionId: 's', scope: 'game-1', attempt: 1, retryable: true })).toMatchObject({ ok: true });
  expect(journal.append({ type: 'running', runId: 'failed-1', at: 2 })).toMatchObject({ ok: true });
  expect(journal.append({ type: 'failed', runId: 'failed-1', at: 3, error: { code: 'resource-failed', hint: 'injected', retryable: true, recoveryActions: ['workflow.retry'] } })).toMatchObject({ ok: true });
  expect(journal.accept({ runId: 'retry-2', operationId: 'asset.write', actor: { id: 'ai', kind: 'ai' }, sessionId: 's', scope: 'game-1', parentRunId: 'failed-1', attempt: 2, retryable: true })).toMatchObject({ ok: true });
  expect(journal.getRun('failed-1')).toMatchObject({ status: 'failed', attempt: 1 });
  expect(journal.getRun('retry-2')).toMatchObject({ status: 'accepted', attempt: 2, parentRunId: 'failed-1' });
});
