import { expect, test } from 'bun:test';

import { RunJournal } from './run-journal';

const request = (runId: string) => ({ runId, operationId: 'asset.write', actor: { id: 'ai', kind: 'ai' as const }, sessionId: 's', scope: 'game-1', idempotencyKey: runId });

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
