import { expect, test } from 'bun:test';

import { RunJournal } from '../run-journal';

const base = {
  operationId: 'asset.import',
  actor: { id: 'agent-1', kind: 'ai' as const },
  sessionId: 'session-1',
  scope: 'game-1',
  input: { path: 'asset.glb' },
  idempotencyKey: 'import-1',
  runId: 'run-1',
};

test('restart rebuilds the run index from append-only records', () => {
  const first = new RunJournal({ scope: 'game-1', now: () => 1 });
  expect(first.accept(base)).toMatchObject({ ok: true });
  expect(first.append({ type: 'running', runId: 'run-1', at: 2 })).toMatchObject({ ok: true });
  expect(first.append({ type: 'succeeded', runId: 'run-1', at: 3, result: { guid: 'asset-1' } })).toMatchObject({ ok: true });

  const restarted = RunJournal.fromRecords({
    scope: 'game-1',
    records: first.listRecords(),
    now: () => 4,
  });
  expect(restarted.getRun('run-1')).toMatchObject({ status: 'succeeded', result: { guid: 'asset-1' } });
  expect(restarted.listEvents('run-1').map((event) => event.type)).toEqual([
    'accepted',
    'running',
    'succeeded',
  ]);
});

test('restart reconciliation keeps an in-flight run explicit and never calls it success', () => {
  const first = new RunJournal({ scope: 'game-1', now: () => 1 });
  expect(first.accept(base)).toMatchObject({ ok: true });
  expect(first.append({ type: 'running', runId: 'run-1', at: 2 })).toMatchObject({ ok: true });
  const restarted = RunJournal.fromRecords({ scope: 'game-1', records: first.listRecords(), now: () => 5 });
  const reconciliation = restarted.reconcile({
    resolve: () => ({ state: 'failed', error: {
      code: 'host-restarted',
      hint: 'The host restarted before the operation completed.',
      retryable: true,
      recoveryActions: ['operation.retry'],
    } }),
  });
  expect(reconciliation).toMatchObject({ ok: true, reconciled: ['run-1'] });
  expect(restarted.getRun('run-1')).toMatchObject({ status: 'failed', error: { code: 'host-restarted' } });
});

test('unknown and expired runs return structured query results', () => {
  const journal = new RunJournal({ scope: 'game-1', now: () => 1, retention: { maxRuns: 1 } });
  expect(journal.getRunResult('missing')).toMatchObject({
    ok: false,
    error: { code: 'run-not-found', recoveryActions: ['run.list'] },
  });
  expect(journal.accept(base)).toMatchObject({ ok: true });
  expect(journal.accept({ ...base, runId: 'run-2', idempotencyKey: 'import-2' })).toMatchObject({ ok: true });
  expect(journal.getRunResult('run-1')).toMatchObject({
    ok: false,
    error: { code: 'run-expired', recoveryActions: ['run.list'] },
  });
});
