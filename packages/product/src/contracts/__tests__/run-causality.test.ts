import { expect, test } from 'bun:test';

import { createOperationRun, type OperationRunRequest } from '../run';

const childRequest: OperationRunRequest = {
  runId: 'child-1',
  operationId: 'asset.write',
  actor: { id: 'agent-1', kind: 'ai' },
  sessionId: 'session-1',
  scope: 'game-1',
  parentRunId: 'parent-1',
  traceId: 'trace-1',
  input: { path: 'scene.pack.json' },
  idempotencyKey: 'child-key',
};

test('run causality keeps actor, session, scope, parent, trace, and attempt facts', () => {
  const created = createOperationRun(childRequest, 10);
  expect(created).toMatchObject({ ok: true });
  if (!created.ok) return;
  expect(created.value).toMatchObject({
    runId: 'child-1',
    actor: { id: 'agent-1', kind: 'ai' },
    sessionId: 'session-1',
    scope: 'game-1',
    parentRunId: 'parent-1',
    traceId: 'trace-1',
    attempt: 1,
    idempotencyKey: 'child-key',
  });
});

test('causality fields are queryable without changing an accepted record', () => {
  const created = createOperationRun(childRequest, 10);
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  const before = structuredClone(created.value);
  expect(created.value.actor).toEqual(before.actor);
  expect(created.value.parentRunId).toBe(before.parentRunId);
  expect(created.value.traceId).toBe(before.traceId);
  expect(Object.isFrozen(created.value)).toBe(true);
});
