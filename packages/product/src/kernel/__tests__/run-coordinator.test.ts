import { expect, test } from 'bun:test';

import {
  OperationRunCoordinator,
  type RunCoordinatorEvent,
} from '../run-coordinator';

test('coordinator exposes accepted, running, and one terminal event', () => {
  const coordinator = new OperationRunCoordinator({ now: () => 1 });
  const accepted = coordinator.accept({
    runId: 'run-1',
    operationId: 'asset.create',
    actor: { id: 'agent-1', kind: 'ai' },
    sessionId: 'session-1',
    scope: 'game-1',
  });
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;

  expect(coordinator.apply({ type: 'running', runId: 'run-1', at: 2 })).toMatchObject({ ok: true });
  expect(coordinator.apply({ type: 'succeeded', runId: 'run-1', at: 3, result: 'ok' })).toMatchObject({ ok: true });
  expect(coordinator.getRun('run-1')).toMatchObject({ status: 'succeeded', result: 'ok' });

  const events = coordinator.listEvents('run-1');
  expect(events.map((entry) => entry.type)).toEqual(['accepted', 'running', 'succeeded']);
  expect(events.filter((entry) => ['succeeded', 'failed', 'cancelled'].includes(entry.type))).toHaveLength(1);
});

test('coordinator rejects terminal duplication and unknown runs without mutation', () => {
  const coordinator = new OperationRunCoordinator({ now: () => 1 });
  expect(coordinator.accept({
    runId: 'run-1',
    operationId: 'asset.create',
    actor: { id: 'agent-1', kind: 'ai' },
    sessionId: 'session-1',
    scope: 'game-1',
  })).toMatchObject({ ok: true });
  expect(coordinator.apply({ type: 'running', runId: 'run-1', at: 2 })).toMatchObject({ ok: true });
  expect(coordinator.apply({ type: 'cancelled', runId: 'run-1', at: 3 })).toMatchObject({ ok: true });

  const duplicate = coordinator.apply({
    type: 'failed',
    runId: 'run-1',
    at: 4,
    error: { code: 'unexpected-failure', hint: 'Unexpected failure.', retryable: false, recoveryActions: [] },
  });
  expect(duplicate).toMatchObject({ ok: false, error: { code: 'run-terminal' } });
  expect(coordinator.getRun('run-1')).toMatchObject({ status: 'cancelled' });

  const unknown = coordinator.apply({ type: 'running', runId: 'missing', at: 5 });
  expect(unknown).toMatchObject({ ok: false, error: { code: 'run-not-found' } });
});

test('coordinator keeps the event contract free of promise or UI completion signals', () => {
  const coordinator = new OperationRunCoordinator({ now: () => 1 });
  const accepted = coordinator.accept({
    runId: 'run-1',
    operationId: 'asset.create',
    actor: { id: 'agent-1', kind: 'ai' },
    sessionId: 'session-1',
    scope: 'game-1',
  });
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;
  const events: RunCoordinatorEvent[] = coordinator.listEvents('run-1');
  expect(events[0]).toMatchObject({ type: 'accepted', runId: 'run-1' });
  expect('promise' in events[0]!).toBe(false);
  expect('toast' in events[0]!).toBe(false);
  expect('console' in events[0]!).toBe(false);
});
