import { expect, test } from 'bun:test';

import { createOperationRun, type OperationRun } from '@forgeax/editor-product';
import { projectSaveRun, type SaveRunProjection } from './run-view-model';

function saveRun(status: OperationRun['status'] = 'running'): OperationRun {
  const created = createOperationRun({
    runId: 'operation-run-panel-1',
    requestId: 'save-panel-1',
    operationId: 'saveDocToDisk',
    actor: { id: 'panel-agent', kind: 'ai' },
    sessionId: 'panel-session',
    scope: 'game-1',
    input: { requestId: 'save-panel-1' },
    cancellable: false,
    retryable: true,
  }, 10);
  if (!created.ok) throw new Error(created.error.hint);
  return Object.freeze({ ...created.value, status, sequence: 4 });
}

test('Operation Center projects the same save fields for human and AI, including dirty semantics', () => {
  const run = saveRun();
  const human = projectSaveRun({ run, dirty: true });
  const ai = projectSaveRun({ run, dirty: true });

  expect(human).toEqual(ai);
  const expected: Partial<SaveRunProjection> = {
    requestId: 'save-panel-1',
    runId: 'operation-run-panel-1',
    status: 'running',
    dirty: true,
    dirtyState: 'pending',
    retryable: true,
    recoveryActions: [],
    sequence: 4,
  };
  expect(human).toMatchObject(expected);
});

test('save projection distinguishes clean, failed, and unavailable without a private completion state', () => {
  const clean = projectSaveRun({ run: saveRun('succeeded'), dirty: false });
  const failed = projectSaveRun({
    run: Object.freeze({
      ...saveRun('failed'),
      error: Object.freeze({ code: 'save-write-failed', hint: 'write rejected', retryable: true, recoveryActions: ['save.retry'] }),
      recoveryActions: Object.freeze(['save.retry']),
    }),
    dirty: true,
  });
  const unavailable = projectSaveRun({
    dirty: true,
    error: { code: 'executor-unavailable', hint: 'no run source', retryable: false, recoveryActions: ['editor.discover'] },
  });

  expect(clean).toMatchObject({ status: 'succeeded', dirty: false, dirtyState: 'clean' });
  expect(failed).toMatchObject({ status: 'failed', dirty: true, dirtyState: 'failed', error: { code: 'save-write-failed' } });
  expect(unavailable).toMatchObject({ status: 'unavailable', dirty: true, dirtyState: 'unavailable', error: { code: 'executor-unavailable' } });
});
