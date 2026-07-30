import { expect, test } from 'bun:test';

import { gateway } from '@forgeax/editor-core';
import { createOperationRun } from '@forgeax/editor-product';
import { createHumanSaveRequest, projectSaveEntry } from '../save-operation-projection';

test('toolbar and keyboard mint requestId and share the save projection shape', () => {
  const toolbar = createHumanSaveRequest();
  const keyboard = createHumanSaveRequest();

  expect(toolbar.kind).toBe('saveDocToDisk');
  expect(toolbar.requestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  expect(keyboard.requestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  expect(keyboard.requestId).not.toBe(toolbar.requestId);
});

test('runtime projection consumes terminal fields and never treats accepted as success', () => {
  const created = createOperationRun({
    runId: 'operation-run-runtime-1',
    requestId: 'save-runtime-1',
    operationId: 'saveDocToDisk',
    actor: { id: 'human', kind: 'human' },
    sessionId: 'runtime-session',
    scope: 'game-1',
    input: { requestId: 'save-runtime-1' },
    cancellable: false,
    retryable: true,
  }, 10);
  if (!created.ok) throw new Error(created.error.hint);

  const pending = projectSaveEntry({ run: created.value, dirty: true });
  const succeeded = projectSaveEntry({ run: Object.freeze({ ...created.value, status: 'succeeded', sequence: 3 }), dirty: false });

  expect(pending).toMatchObject({ requestId: 'save-runtime-1', status: 'accepted', dirty: true, dirtyState: 'pending' });
  expect(pending.isSuccess).toBe(false);
  expect(succeeded).toMatchObject({ requestId: 'save-runtime-1', status: 'succeeded', dirty: false, dirtyState: 'clean' });
  expect(succeeded.isSuccess).toBe(true);
});

test('runtime projection follows Gateway-owned terminal updates for a human save', async () => {
  const statuses: string[] = [];
  const unsubscribe = gateway.subscribeOperationRuns((run) => statuses.push(run.status));
  const requestId = `save-runtime-live-${globalThis.crypto.randomUUID()}`;
  const accepted = gateway.dispatch({ kind: 'saveDocToDisk', requestId }, 'human');
  if (!accepted.ok) throw new Error(accepted.error.hint);
  const pending = projectSaveEntry({ run: accepted.result?.operationRun, dirty: true });
  expect(pending).toMatchObject({ requestId, status: 'running', dirtyState: 'pending' });

  const terminal = await gateway.waitOperationRun(requestId);
  if (!terminal.ok) throw new Error(terminal.error.hint);
  const projected = projectSaveEntry({ run: terminal.value, dirty: terminal.value.status !== 'succeeded' });
  unsubscribe();

  expect(statuses[0]).toBe('accepted');
  expect(statuses.at(-1)).toBe(terminal.value.status);
  expect(projected).toMatchObject({
    requestId,
    runId: terminal.value.runId,
    status: terminal.value.status,
    dirtyState: terminal.value.status === 'succeeded' ? 'clean' : 'failed',
  });
  expect(projected.isSuccess).toBe(terminal.value.status === 'succeeded');
});
