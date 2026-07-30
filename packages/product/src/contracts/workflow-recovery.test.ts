import { expect, test } from 'bun:test';

import {
  isWorkflowRecoveryAction,
  recoveryActionsForWorkflow,
} from '../kernel/workflow-recovery';
import type { WorkflowRun } from './workflow';

function workflow(): WorkflowRun {
  const parentRunId = 'workflow-failed';
  const actions = (['retry', 'continue', 'stop', 'compensate', 'require-confirmation'] as const).map((kind) => ({
    actionId: `workflow.${kind}:child-1`, kind, runId: 'child-1', parentRunId, stepId: 'write', capabilityId: 'asset.write', requiresConfirmation: kind === 'compensate' || kind === 'require-confirmation',
  }));
  return {
    ok: true, runId: parentRunId, operationId: 'workflow.recipe', recipeId: 'recipe', status: 'failed', actor: { id: 'ai', kind: 'ai' }, sessionId: 'session', scope: 'game', attempt: 1,
    childRuns: [{ runId: 'child-1', parentRunId, stepId: 'write', capabilityId: 'asset.write', status: 'failed', attempt: 1, actor: { id: 'ai', kind: 'ai' }, input: { id: 'asset' }, effectKey: 'workflow-failed:write', error: { code: 'resource-failed', hint: 'injected', retryable: true, recoveryActions: ['workflow.retry'] }, recoveryActions: actions }],
    recoveryActions: actions,
  };
}

test('recovery actions carry target run, parent, capability, and confirmation facts', () => {
  const actions = recoveryActionsForWorkflow(workflow());
  expect(actions).toHaveLength(5);
  expect(actions.every((action) => isWorkflowRecoveryAction(action))).toBe(true);
  expect(actions.find((action) => action.kind === 'require-confirmation')).toMatchObject({ runId: 'child-1', parentRunId: 'workflow-failed', capabilityId: 'asset.write', requiresConfirmation: true });
});

test('invalid recovery actions are rejected without reading a human message', () => {
  expect(isWorkflowRecoveryAction({ actionId: 'x', kind: 'retry', runId: 'child', parentRunId: 'parent', stepId: 'write', capabilityId: 'asset.write', requiresConfirmation: 'yes' })).toBe(false);
});
