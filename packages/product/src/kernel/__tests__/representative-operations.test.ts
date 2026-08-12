import { expect, test } from 'bun:test';

import {
  OperationRunCoordinator,
  REPRESENTATIVE_OPERATION_IDS,
} from '../run-coordinator';

test('all representative operations return a runId before terminal inspection', () => {
  const coordinator = new OperationRunCoordinator({ now: () => 1 });
  for (const operationId of REPRESENTATIVE_OPERATION_IDS) {
    coordinator.registerOperation({
      operationId,
      execute: (input) => ({ operationId, input }),
    });
  }

  for (const operationId of REPRESENTATIVE_OPERATION_IDS) {
    const accepted = coordinator.dispatchOperation(operationId, { fixture: operationId }, {
      runId: `run-${operationId}`,
      actor: { id: 'agent-1', kind: 'ai' },
      sessionId: 'session-1',
      scope: 'game-1',
    });
    expect(accepted).toMatchObject({ ok: true });
    if (!accepted.ok) continue;
    expect(accepted.runId).toBeTruthy();
    const run = coordinator.getRun(accepted.runId);
    expect(run).toMatchObject({
      runId: accepted.runId,
      operationId,
      status: 'succeeded',
    });
    expect(coordinator.listEvents(accepted.runId).some((event) => event.type === 'succeeded')).toBe(true);
  }
});

test('representative operation progress is read from events, not UI signals', () => {
  const coordinator = new OperationRunCoordinator({ now: () => 1 });
  coordinator.registerOperation({
    operationId: 'importAsset',
    execute: () => ({ imported: true }),
  });
  const accepted = coordinator.dispatchOperation('importAsset', {}, {
    runId: 'run-import',
    actor: { id: 'agent-1', kind: 'ai' },
    sessionId: 'session-1',
    scope: 'game-1',
  });
  expect(accepted).toMatchObject({ ok: true });
  if (!accepted.ok) return;
  const events = coordinator.listEvents(accepted.runId);
  expect(events.map((event) => event.type)).toEqual(['accepted', 'running', 'progress', 'succeeded']);
  expect(events.find((event) => event.type === 'progress')).toMatchObject({
    progress: { fraction: 1 },
  });
  expect(events.every((event) => !('toast' in event) && !('console' in event))).toBe(true);
});
