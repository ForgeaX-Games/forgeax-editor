import { expect, test } from 'bun:test';

import { RunJournal } from './run-journal';

test('unknown and expired run queries expose machine recovery and diagnostic facts', () => {
  const journal = new RunJournal({ scope: 'game-1', retention: { maxRuns: 1 } });
  expect(journal.getRunResult('unknown')).toMatchObject({ ok: false, error: { code: 'run-not-found', recoveryActions: ['run.list'] } });
  expect(journal.accept({ runId: 'old', operationId: 'asset.write', actor: { id: 'ai', kind: 'ai' }, sessionId: 's', scope: 'game-1' })).toMatchObject({ ok: true });
  expect(journal.accept({ runId: 'new', operationId: 'asset.write', actor: { id: 'ai', kind: 'ai' }, sessionId: 's', scope: 'game-1' })).toMatchObject({ ok: true });
  const expired = journal.getRunResult('old');
  expect(expired).toMatchObject({ ok: false, error: { code: 'run-expired', retryable: false, recoveryActions: ['run.list'] } });
  if (!expired.ok) expect(expired.error.hint.toLowerCase()).toContain('expired');
});

test('retention does not allow an equivalent expired idempotency key to create a hidden duplicate', () => {
  const journal = new RunJournal({ scope: 'game-1', retention: { maxRuns: 1 } });
  const request = { runId: 'old', operationId: 'asset.write', actor: { id: 'ai', kind: 'ai' as const }, sessionId: 's', scope: 'game-1', input: { id: 'asset' }, idempotencyKey: 'same' };
  expect(journal.accept(request)).toMatchObject({ ok: true });
  expect(journal.accept({ ...request, runId: 'new', idempotencyKey: 'other' })).toMatchObject({ ok: true });
  expect(journal.accept({ ...request, runId: 'duplicate' })).toMatchObject({ ok: false, error: { code: 'run-expired' } });
});
