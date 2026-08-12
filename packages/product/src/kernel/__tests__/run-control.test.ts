import { expect, test } from 'bun:test';

import { OperationRunCoordinator } from '../run-coordinator';

function coordinator(): OperationRunCoordinator {
  return new OperationRunCoordinator({ now: () => 1 });
}

function request(runId: string, operationId = 'asset.import') {
  return {
    runId,
    operationId,
    actor: { id: 'agent-1', kind: 'ai' as const },
    sessionId: 'session-1',
    scope: 'game-1',
    cancellable: true,
    retryable: true,
    input: { path: 'asset.glb' },
  };
}

test('cancellable runs reach cancelled without a partial terminal result', () => {
  const runs = coordinator();
  expect(runs.accept(request('run-1'))).toMatchObject({ ok: true });
  expect(runs.apply({ type: 'running', runId: 'run-1', at: 2 })).toMatchObject({ ok: true });
  expect(runs.updateProgress('run-1', { fraction: 0.25, stage: 'upload' })).toMatchObject({ ok: true });
  expect(runs.cancelRun('run-1')).toMatchObject({ ok: true });
  expect(runs.getRun('run-1')).toMatchObject({ status: 'cancelled' });
  expect(runs.getRun('run-1')?.result).toBeUndefined();
  expect(runs.listEvents('run-1').map((event) => event.type)).toEqual([
    'accepted',
    'running',
    'progress',
    'cancelled',
  ]);
});

test('non-cancellable phases reject cancellation with a structured reason', () => {
  const runs = coordinator();
  expect(runs.accept({ ...request('run-1'), cancellable: false })).toMatchObject({ ok: true });
  expect(runs.apply({ type: 'running', runId: 'run-1', at: 2 })).toMatchObject({ ok: true });
  const cancelled = runs.cancelRun('run-1');
  expect(cancelled).toMatchObject({
    ok: false,
    error: { code: 'run-not-cancellable', retryable: false },
  });
  expect(runs.getRun('run-1')?.status).toBe('running');
});

test('retry creates a new attempt and preserves the failed run', () => {
  const runs = coordinator();
  expect(runs.accept(request('run-1'))).toMatchObject({ ok: true });
  expect(runs.apply({ type: 'running', runId: 'run-1', at: 2 })).toMatchObject({ ok: true });
  expect(runs.failRun('run-1', {
    code: 'asset-write-failed',
    hint: 'Write failed.',
    retryable: true,
    recoveryActions: ['operation.retry'],
  })).toMatchObject({ ok: true });
  const retry = runs.retryRun('run-1', 'run-2');
  expect(retry).toMatchObject({ ok: true, runId: 'run-2' });
  expect(runs.getRun('run-1')).toMatchObject({ status: 'failed', attempt: 1 });
  expect(runs.getRun('run-2')).toMatchObject({
    status: 'accepted',
    attempt: 2,
    parentRunId: 'run-1',
  });
  expect(runs.getRun('run-2')?.progress).toEqual({ fraction: 0, stage: 'accepted' });
});
