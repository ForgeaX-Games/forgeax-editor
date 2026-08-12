import { expect, test } from 'bun:test';

import { RunJournal } from '../run-journal';

const request = (runId: string) => ({ runId, operationId: 'asset.write', actor: { id: 'ai', kind: 'ai' as const }, sessionId: 's', scope: 'game-1', idempotencyKey: runId });

const saveRequest = (requestId: string, runId = requestId, input: unknown = { scene: 'main' }) => ({
  runId,
  requestId,
  operationId: 'saveDocToDisk',
  actor: { id: 'ai', kind: 'ai' as const },
  sessionId: 's',
  scope: 'game-1',
  input,
});

test('retention expires the derived index but never deletes append-only records', () => {
  const journal = new RunJournal({ scope: 'game-1', retention: { maxRuns: 1 } });
  expect(journal.accept(request('run-1'))).toMatchObject({ ok: true });
  expect(journal.accept(request('run-2'))).toMatchObject({ ok: true });
  expect(journal.getRun('run-1')).toBeUndefined();
  expect(journal.getRunResult('run-1')).toMatchObject({ ok: false, error: { code: 'run-expired', recoveryActions: ['run.list'] } });
  expect(journal.listRecords().filter((record) => record.runId === 'run-1')).toHaveLength(1);
  expect(journal.listRuns().map((run) => run.runId)).toEqual(['run-2']);
});

test('rebuilding a retained journal preserves the old terminal and child causality facts', () => {
  const source = new RunJournal({ scope: 'game-1', retention: { maxRuns: 1 } });
  expect(source.accept({ ...request('parent'), operationId: 'workflow.recipe' })).toMatchObject({ ok: true });
  expect(source.append({ type: 'running', runId: 'parent', at: 2 })).toMatchObject({ ok: true });
  expect(source.append({ type: 'succeeded', runId: 'parent', at: 3, result: { complete: true } })).toMatchObject({ ok: true });
  expect(source.accept({ ...request('child'), operationId: 'asset.write', parentRunId: 'parent' })).toMatchObject({ ok: true });
  const records = source.listRecords();
  const rebuilt = RunJournal.fromRecords({ scope: 'game-1', retention: { maxRuns: 1 }, records });
  expect(rebuilt.getRunResult('parent')).toMatchObject({ ok: false, error: { code: 'run-expired' } });
  expect(rebuilt.listRecords().some((record) => record.runId === 'parent' && record.type === 'succeeded')).toBe(true);
  expect(rebuilt.listRecords().some((record) => record.runId === 'child' && record.type === 'accepted')).toBe(true);
});

test('requestId reuses an equivalent run and rejects conflicting intent', () => {
  const journal = new RunJournal({ scope: 'game-1', retention: { maxTerminalRuns: 64 } });
  const first = journal.accept(saveRequest('save-1', 'run-1', { scene: 'main', revision: 1 }));
  expect(first).toMatchObject({ ok: true, reused: false, runId: 'run-1', run: { requestId: 'save-1' } });
  if (!first.ok) return;

  const duplicate = journal.accept(saveRequest('save-1', 'run-2', { revision: 1, scene: 'main' }));
  expect(duplicate).toMatchObject({ ok: true, reused: true, runId: 'run-1', run: { requestId: 'save-1' } });

  const conflict = journal.accept(saveRequest('save-1', 'run-3', { scene: 'other', revision: 1 }));
  expect(conflict).toMatchObject({ ok: false, error: { code: 'operation-request-id-conflict' } });
  expect(journal.getRunByRequestId('save-1')).toEqual(first.run);
  expect(journal.getRunResultByRequestId('save-1')).toEqual({ ok: true, value: first.run });
});

test('terminal-only retention keeps active runs and expires by terminal completion order', () => {
  const journal = new RunJournal({ scope: 'game-1', retention: { maxTerminalRuns: 64 } });
  const active = journal.accept(saveRequest('active', 'active'));
  expect(active).toMatchObject({ ok: true });

  for (let index = 1; index <= 65; index++) {
    const runId = `terminal-${index}`;
    expect(journal.accept(saveRequest(runId, runId, { revision: index }))).toMatchObject({ ok: true });
    expect(journal.append({ type: 'running', runId, at: index * 2 })).toMatchObject({ ok: true });
    expect(journal.append({ type: 'succeeded', runId, at: index * 2 + 1, result: { revision: index } })).toMatchObject({ ok: true });
  }

  expect(journal.getRunResultByRequestId('active')).toMatchObject({ ok: true, value: { status: 'accepted' } });
  expect(journal.getRunResultByRequestId('terminal-1')).toMatchObject({ ok: false, error: { code: 'run-expired' } });
  expect(journal.getRunResultByRequestId('terminal-2')).toMatchObject({ ok: true, value: { status: 'succeeded' } });
  expect(journal.getRunResultByRequestId('never-seen')).toMatchObject({ ok: false, error: { code: 'run-not-found' } });
  expect(journal.listRuns().some((run) => run.runId === 'active')).toBe(true);
  expect(journal.listRuns().filter((run) => run.status === 'succeeded')).toHaveLength(64);
});
