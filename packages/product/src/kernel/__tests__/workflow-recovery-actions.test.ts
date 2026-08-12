import { expect, test } from 'bun:test';

import { recoverWorkflow } from '../workflow-recovery';
import type { WorkflowRun } from '../../contracts/workflow';

const failed: WorkflowRun = {
  ok: true, runId: 'parent', operationId: 'workflow.recipe', recipeId: 'recipe', status: 'failed', actor: { id: 'ai', kind: 'ai' }, sessionId: 's', scope: 'game', attempt: 1,
  childRuns: [{ runId: 'child', parentRunId: 'parent', stepId: 'write', capabilityId: 'asset.write', status: 'failed', attempt: 1, actor: { id: 'ai', kind: 'ai' }, effectKey: 'parent:write', recoveryActions: [{ actionId: 'workflow.retry:child', kind: 'retry', runId: 'child', parentRunId: 'parent', stepId: 'write', capabilityId: 'asset.write', requiresConfirmation: false }] }],
  recoveryActions: [{ actionId: 'workflow.retry:child', kind: 'retry', runId: 'child', parentRunId: 'parent', stepId: 'write', capabilityId: 'asset.write', requiresConfirmation: false }],
};

test('AI can execute retry from fields and does not parse message text', () => {
  const result = recoverWorkflow({ getWorkflow: () => failed, retryWorkflow: (_runId, retryRunId) => ({ ok: true, runId: retryRunId, reused: false, run: failed, completion: Promise.resolve(failed) }) }, { action: 'retry', runId: 'parent', actionId: 'workflow.retry:child', newRunId: 'parent:retry' });
  expect(result).toMatchObject({ ok: true, status: 'started', action: { kind: 'retry', runId: 'child' } });
});

test('unknown, unavailable, and confirmation recovery paths stay structured', () => {
  const port = { getWorkflow: () => failed, retryWorkflow: () => ({ ok: false as const, error: { code: 'blocked', hint: 'blocked', retryable: false, recoveryActions: [] } }) };
  expect(recoverWorkflow(port, { action: 'compensate', runId: 'parent', actionId: 'workflow.compensate:child' })).toMatchObject({ ok: false, error: { code: 'recovery-action-unavailable' } });
  expect(recoverWorkflow({ ...port, getWorkflow: () => undefined }, { action: 'retry', runId: 'missing', actionId: 'workflow.retry:child' })).toMatchObject({ ok: false, error: { code: 'run-not-found', recoveryActions: ['run.list'] } });
});
