import { expect, test } from 'bun:test';

import {
  acceptedEvent,
  createOperationRun,
  isOperationRun,
  isTerminalRunStatus,
  OperationRunSchema,
  reduceOperationRun,
  type OperationRunEvent,
} from './run';

const request = {
  operationId: 'asset.create',
  actor: { id: 'agent-1', kind: 'ai' as const },
  sessionId: 'session-1',
  scope: 'game-1',
  idempotencyKey: 'create-1',
  traceId: 'trace-1',
};

function event<T extends OperationRunEvent['type']>(
  type: T,
  extra: Partial<Omit<Extract<OperationRunEvent, { type: T }>, 'type' | 'runId' | 'sequence' | 'at'>> & { sequence?: number; at?: number } = {},
): OperationRunEvent {
  return { type, runId: 'run-1', sequence: extra.sequence ?? 2, at: extra.at ?? 2, ...extra } as OperationRunEvent;
}

test('OperationRun accepts running and exactly one terminal state', () => {
  const accepted = createOperationRun({ ...request, runId: 'run-1' }, 1);
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;

  const running = reduceOperationRun(accepted.value, event('running', { sequence: 2, at: 2 }));
  expect(running.ok).toBe(true);
  if (!running.ok) return;

  const progress = reduceOperationRun(
    running.value,
    event('progress', { sequence: 3, at: 3, progress: { fraction: 0.5, stage: 'write' } }),
  );
  expect(progress.ok).toBe(true);
  if (!progress.ok) return;

  const succeeded = reduceOperationRun(
    progress.value,
    event('succeeded', { sequence: 4, at: 4, result: { guid: 'asset-1' } }),
  );
  expect(succeeded.ok).toBe(true);
  if (!succeeded.ok) return;
  expect(succeeded.value.status).toBe('succeeded');
  expect(isTerminalRunStatus(succeeded.value.status)).toBe(true);
  expect(succeeded.value.result).toEqual({ guid: 'asset-1' });
  expect(succeeded.value.error).toBeUndefined();
  expect(succeeded.value.progress).toEqual({ fraction: 1, stage: 'succeeded' });
});

test('every terminal event closes progress instead of preserving a stale running stage', () => {
  const terminalEvents = [
    event('failed', {
      sequence: 3,
      at: 3,
      error: {
        code: 'asset-write-failed',
        hint: 'The resource write failed.',
        retryable: true,
        recoveryActions: ['operation.retry'],
      },
    }),
    event('cancelled', { sequence: 3, at: 3 }),
  ] as const;

  for (const terminalEvent of terminalEvents) {
    const accepted = createOperationRun({ ...request, runId: 'run-1' }, 1);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) continue;
    const running = reduceOperationRun(accepted.value, event('running', { sequence: 2, at: 2 }));
    expect(running.ok).toBe(true);
    if (!running.ok) continue;
    const terminal = reduceOperationRun(running.value, terminalEvent);
    expect(terminal.ok).toBe(true);
    if (!terminal.ok) continue;
    expect(terminal.value.progress).toEqual({ fraction: 1, stage: terminal.value.status });
  }
});

test('accepted and running are never terminal or successful', () => {
  const accepted = createOperationRun({ ...request, runId: 'run-1' }, 1);
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;
  expect(isTerminalRunStatus(accepted.value.status)).toBe(false);

  const running = reduceOperationRun(accepted.value, event('running', { sequence: 2, at: 2 }));
  expect(running.ok).toBe(true);
  if (!running.ok) return;
  expect(running.value.status).toBe('running');
  expect(isTerminalRunStatus(running.value.status)).toBe(false);

  const shortcut = reduceOperationRun(
    accepted.value,
    event('succeeded', { sequence: 2, at: 2, result: true }),
  );
  expect(shortcut.ok).toBe(false);
  if (shortcut.ok) return;
  expect(shortcut.error.code).toBe('invalid-run-transition');
});

test('terminal states reject duplicate terminal and backward events', () => {
  const accepted = createOperationRun({ ...request, runId: 'run-1' }, 1);
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;
  const running = reduceOperationRun(accepted.value, event('running', { sequence: 2, at: 2 }));
  expect(running.ok).toBe(true);
  if (!running.ok) return;
  const failed = reduceOperationRun(
    running.value,
    event('failed', {
      sequence: 3,
      at: 3,
      error: {
        code: 'asset-write-failed',
        hint: 'The resource write failed.',
        retryable: true,
        recoveryActions: ['operation.retry'],
      },
    }),
  );
  expect(failed.ok).toBe(true);
  if (!failed.ok) return;

  const duplicate = reduceOperationRun(
    failed.value,
    event('succeeded', { sequence: 4, at: 4, result: true }),
  );
  expect(duplicate.ok).toBe(false);
  if (duplicate.ok) return;
  expect(duplicate.error.code).toBe('run-terminal');

  const backwards = reduceOperationRun(
    failed.value,
    event('running', { sequence: 4, at: 4 }),
  );
  expect(backwards.ok).toBe(false);
  if (backwards.ok) return;
  expect(backwards.error.code).toBe('run-terminal');
});

test('invalid run identity and missing terminal are structured failures', () => {
  const missingId = createOperationRun({ ...request, runId: '' }, 1);
  expect(missingId.ok).toBe(false);
  if (!missingId.ok) expect(missingId.error.code).toBe('invalid-run-id');

  const accepted = createOperationRun({ ...request, runId: 'run-1' }, 1);
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;
  const terminalCheck = reduceOperationRun(accepted.value, {
    type: 'assert-terminal',
    runId: 'run-1',
    sequence: 2,
    at: 2,
  });
  expect(terminalCheck.ok).toBe(false);
  if (!terminalCheck.ok) expect(terminalCheck.error.code).toBe('run-not-terminal');
});

test('requestId is carried by the operation run and accepted event', () => {
  const accepted = createOperationRun({ ...request, runId: 'run-1', requestId: 'save-1' }, 1);
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;

  expect(accepted.value.requestId).toBe('save-1');
  expect(acceptedEvent(accepted.value)).toMatchObject({
    type: 'accepted',
    requestId: 'save-1',
  });
});

test('requestId format is validated at the OperationRun boundary', () => {
  expect(createOperationRun({ ...request, runId: 'run-1', requestId: '' }, 1)).toMatchObject({
    ok: false,
    error: { code: 'invalid-request-id' },
  });
  expect(createOperationRun({ ...request, runId: 'run-1', requestId: 'bad id' }, 1)).toMatchObject({
    ok: false,
    error: { code: 'invalid-request-id' },
  });
  expect(createOperationRun({ ...request, runId: 'run-1', requestId: `a${'x'.repeat(127)}` }, 1)).toMatchObject({ ok: true });
  expect(createOperationRun({ ...request, runId: 'run-1', requestId: `a${'x'.repeat(128)}` }, 1)).toMatchObject({
    ok: false,
    error: { code: 'invalid-request-id' },
  });
});

test('OperationRunSchema machine-validates every lifecycle shape without promoting accepted to success', () => {
  const accepted = createOperationRun({ ...request, runId: 'run-1', requestId: 'save-1' }, 1);
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;
  expect(OperationRunSchema.safeParse(accepted.value)).toMatchObject({ success: true });
  expect(isOperationRun(accepted.value)).toBe(true);

  const running = reduceOperationRun(accepted.value, event('running', { sequence: 2, at: 2 }));
  expect(running.ok).toBe(true);
  if (!running.ok) return;
  expect(OperationRunSchema.safeParse(running.value)).toMatchObject({ success: true });

  const succeeded = reduceOperationRun(running.value, event('succeeded', { sequence: 3, at: 3, result: { revision: 2 } }));
  expect(succeeded.ok).toBe(true);
  if (!succeeded.ok) return;
  expect(OperationRunSchema.safeParse(succeeded.value)).toMatchObject({ success: true });
});

test('OperationRunSchema rejects malformed transport facts and impossible lifecycle combinations', () => {
  const accepted = createOperationRun({ ...request, runId: 'run-1' }, 1);
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;

  const malformed = {
    ...accepted.value,
    status: 'succeeded',
    completedAt: 2,
    error: { code: 'broken' },
  };
  const parsed = OperationRunSchema.safeParse(malformed);
  expect(parsed.success).toBe(false);
  if (parsed.success) return;
  expect(parsed.error.issues).toEqual(expect.arrayContaining([
    'error must be a structured CommandError.',
    'succeeded runs require startedAt/completedAt and cannot carry an error.',
  ]));
  expect(isOperationRun(malformed)).toBe(false);
});

test('the reducer rejects progress that would publish an invalid OperationRun', () => {
  const accepted = createOperationRun({ ...request, runId: 'run-1' }, 1);
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;
  const running = reduceOperationRun(accepted.value, event('running', { sequence: 2, at: 2 }));
  expect(running.ok).toBe(true);
  if (!running.ok) return;
  const invalid = reduceOperationRun(running.value, event('progress', {
    sequence: 3,
    at: 3,
    progress: { fraction: 2, stage: 'invalid' },
  }));
  expect(invalid).toMatchObject({ ok: false, error: { code: 'invalid-run-schema' } });
});
