import { expect, test } from 'bun:test';

import { RunJournal } from './run-journal';

const request = {
  operationId: 'asset.create',
  actor: { id: 'agent-1', kind: 'ai' as const },
  sessionId: 'session-1',
  scope: 'game-1',
  input: { guid: 'asset-1', name: 'Box' },
  idempotencyKey: 'key-1',
  runId: 'run-1',
};

test('equivalent idempotent requests reuse one run and do not repeat mutation', () => {
  const journal = new RunJournal({ scope: 'game-1', now: () => 1 });
  const first = journal.accept(request);
  expect(first).toMatchObject({ ok: true, runId: 'run-1', reused: false });
  const second = journal.accept({ ...request, runId: 'run-2' });
  expect(second).toMatchObject({ ok: true, runId: 'run-1', reused: true });
  expect(journal.listRecords()).toHaveLength(1);
  expect(journal.getRun('run-1')).toMatchObject({
    actor: { id: 'agent-1', kind: 'ai' },
    sessionId: 'session-1',
    scope: 'game-1',
  });
});

test('non-equivalent idempotent requests are rejected structurally', () => {
  const journal = new RunJournal({ scope: 'game-1', now: () => 1 });
  expect(journal.accept(request)).toMatchObject({ ok: true });
  const conflict = journal.accept({
    ...request,
    runId: 'run-2',
    input: { guid: 'asset-2', name: 'Sphere' },
  });
  expect(conflict).toMatchObject({
    ok: false,
    error: { code: 'idempotency-conflict', retryable: false },
  });
  expect(journal.listRecords()).toHaveLength(1);
});

test('idempotency identity includes operation and scope, not only the key', () => {
  const journal = new RunJournal({ scope: 'game-1', now: () => 1 });
  expect(journal.accept(request)).toMatchObject({ ok: true });
  const otherOperation = journal.accept({ ...request, operationId: 'asset.rename', runId: 'run-2' });
  expect(otherOperation).toMatchObject({ ok: true, runId: 'run-2', reused: false });
  const otherScope = journal.accept({ ...request, scope: 'game-2', runId: 'run-3' });
  expect(otherScope).toMatchObject({ ok: false, error: { code: 'scope-mismatch' } });
});
