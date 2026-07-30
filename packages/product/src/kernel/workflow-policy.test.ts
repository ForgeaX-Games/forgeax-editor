import { expect, test } from 'bun:test';

import { CapabilityRegistry } from './capability-registry';
import { RunJournal } from './run-journal';
import { WorkflowCoordinator, type WorkflowRecipe } from './workflow-coordinator';
import { recoverWorkflow } from './workflow-recovery';

function setup(policy: WorkflowRecipe['failurePolicy']): WorkflowCoordinator {
  const registry = new CapabilityRegistry();
  registry.register({
    id: 'asset.fail', kind: 'operation', version: '1', subject: 'asset', verb: 'fail',
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, availability: { available: true },
    preconditions: [], recoveryActions: ['workflow.retry'], retry: { supported: true, createsNewAttempt: true },
    executor: { execute: () => ({ ok: false, error: { code: 'resource-failed', hint: 'injected', retryable: true, recoveryActions: ['workflow.retry'] } }) },
  });
  registry.register({
    id: 'asset.after', kind: 'operation', version: '1', subject: 'asset', verb: 'after',
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, availability: { available: true },
    preconditions: [], recoveryActions: [], executor: { execute: () => ({ after: true }) },
  });
  return new WorkflowCoordinator({ registry, journal: new RunJournal({ scope: 'game-1' }) });
}

function recipe(policy: WorkflowRecipe['failurePolicy']): WorkflowRecipe {
  return {
    schemaVersion: 'workflow/v1', id: `recipe.${policy}`, version: '1', failurePolicy: policy,
    steps: [
      { id: 'a-failed', capabilityId: 'asset.fail', input: {} },
      { id: 'z-after', capabilityId: 'asset.after', input: {} },
    ],
  };
}

for (const policy of ['stop', 'continue', 'compensate', 'require-confirmation'] as const) {
  test(`child failure exposes the ${policy} policy as an explicit parent terminal`, async () => {
    const coordinator = setup(policy);
    const started = coordinator.startWorkflow(recipe(policy), {
      runId: `workflow-${policy}`,
      actor: { id: 'ai-1', kind: 'ai' }, sessionId: 'session-1', scope: 'game-1',
    });
    if (!started.ok) throw new Error(started.error.hint);
    const terminal = await started.completion;
    expect(terminal.status).toBe(policy === 'continue' ? 'succeeded' : 'failed');
    expect(terminal.childRuns[0]?.status).toBe('failed');
    expect(terminal.childRuns[0]?.recoveryActions.length).toBeGreaterThan(0);
    if (policy === 'continue') expect(terminal.childRuns.map((run) => run.stepId)).toEqual(['a-failed', 'z-after']);
    if (policy === 'compensate') expect(terminal.error?.code).toBe('workflow-compensation-required');
    if (policy === 'require-confirmation') expect(terminal.error?.code).toBe('confirmation-required');
  });
}

test('retry creates a new parent attempt and keeps the original failed run immutable', async () => {
  const coordinator = setup('stop');
  const recipeValue = recipe('stop');
  const first = coordinator.startWorkflow(recipeValue, {
    runId: 'workflow-original', actor: { id: 'ai-1', kind: 'ai' }, sessionId: 'session-1', scope: 'game-1', idempotencyKey: 'attempt-1',
  });
  if (!first.ok) throw new Error(first.error.hint);
  const original = await first.completion;
  const retry = coordinator.retryWorkflow('workflow-original', 'workflow-retry');
  expect(retry).toMatchObject({ ok: true, runId: 'workflow-retry' });
  if (!retry.ok) return;
  const retried = await retry.completion;
  expect(retried.attempt).toBe(2);
  expect(coordinator.getWorkflow('workflow-original')?.status).toBe(original.status);
  expect(coordinator.getWorkflow('workflow-retry')?.parentRunId).toBe('workflow-original');
  const replay = coordinator.retryWorkflow('workflow-original', 'workflow-retry');
  expect(replay).toMatchObject({ ok: true, reused: true, runId: 'workflow-retry' });
});

test('workflow recovery routes by actionId and records an explicit stop recovery run', async () => {
  const coordinator = setup('stop');
  const started = coordinator.startWorkflow(recipe('stop'), {
    runId: 'workflow-stop-recovery', actor: { id: 'ai-1', kind: 'ai' }, sessionId: 'session-1', scope: 'game-1',
  });
  if (!started.ok) throw new Error(started.error.hint);
  const terminal = await started.completion;
  const action = terminal.recoveryActions.find((candidate) => candidate.kind === 'stop');
  if (action === undefined) throw new Error('stop recovery action was not published');

  const result = recoverWorkflow(coordinator, { action: 'stop', runId: terminal.runId, actionId: action.actionId, newRunId: 'workflow-stop-recovery:stop' });
  expect(result).toMatchObject({ ok: true, status: 'started', action: { actionId: action.actionId, runId: action.runId } });
  expect(coordinator.journal.getRun('workflow-stop-recovery:stop')).toMatchObject({ status: 'succeeded', operationId: 'workflow.recovery.stop' });
  expect(recoverWorkflow(coordinator, { action: 'stop', runId: terminal.runId, actionId: 'workflow.stop:wrong-child' })).toMatchObject({ ok: false, error: { code: 'recovery-action-unavailable' } });
  expect(coordinator.retryWorkflow(terminal.runId, 'workflow-stop-recovery:stop')).toMatchObject({ ok: false, error: { code: 'recovery-run-conflict' } });
});

test('compensation and confirmation actions are explicit and fail closed without a safe executor', async () => {
  for (const policy of ['compensate', 'require-confirmation'] as const) {
    const coordinator = setup(policy);
    const started = coordinator.startWorkflow(recipe(policy), {
      runId: `workflow-${policy}-recovery`, actor: { id: 'ai-1', kind: 'ai' }, sessionId: 'session-1', scope: 'game-1',
    });
    if (!started.ok) throw new Error(started.error.hint);
    const terminal = await started.completion;
    const action = terminal.recoveryActions.find((candidate) => candidate.kind === policy);
    if (action === undefined) throw new Error(`${policy} recovery action was not published`);
    const request = { action: policy, runId: terminal.runId, actionId: action.actionId, confirmationToken: `confirm:${action.actionId}` } as const;
    expect(recoverWorkflow(coordinator, request)).toMatchObject({ ok: false, error: { code: 'recovery-action-unavailable' } });
  }
});
