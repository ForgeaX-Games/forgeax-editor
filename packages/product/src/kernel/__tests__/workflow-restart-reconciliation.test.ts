import { expect, test } from 'bun:test';

import { CapabilityRegistry } from '../capability-registry';
import { RunJournal } from '../run-journal';
import { reconcileRestartedRuns } from '../run-reconciliation';
import { WorkflowCoordinator, type WorkflowRecipe } from '../workflow-coordinator';

function recipe(): WorkflowRecipe {
  return {
    schemaVersion: 'workflow/v1', id: 'recipe.restart', version: '1', failurePolicy: 'stop',
    steps: [
      { id: 'write', capabilityId: 'asset.write', input: { id: 'asset-1' } },
      { id: 'save', capabilityId: 'asset.save', dependsOn: ['write'], input: { id: 'asset-1' } },
    ],
  };
}

function registry(sideEffects: string[]): CapabilityRegistry {
  const value = new CapabilityRegistry();
  for (const verb of ['write', 'save']) {
    value.register({
      id: `asset.${verb}`, kind: 'operation', version: '1', subject: 'asset', verb,
      inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      outputSchema: { type: 'object' }, availability: { available: true }, preconditions: [], recoveryActions: [],
      executor: { execute: (input) => { sideEffects.push(`${verb}:${JSON.stringify(input)}`); return { verb, input }; } },
    });
  }
  return value;
}

test('restart reconciliation rebuilds parent and child facts without replaying committed effects', async () => {
  const effects: string[] = [];
  const first = new WorkflowCoordinator({ registry: registry(effects), journal: new RunJournal({ scope: 'game-1' }) });
  const started = first.startWorkflow(recipe(), {
    runId: 'workflow-restart', actor: { id: 'ai-1', kind: 'ai' }, sessionId: 'session-1', scope: 'game-1',
  });
  if (!started.ok) throw new Error(started.error.hint);
  await started.completion;
  const records = first.journal.listRecords();

  const restarted = new RunJournal({ scope: 'game-1' });
  const restored = RunJournal.fromRecords({ scope: 'game-1', records });
  expect(restored.getRun('workflow-restart')?.status).toBe('succeeded');
  const result = reconcileRestartedRuns(restored, {
    committedEffectKeys: new Set(['workflow-restart:write', 'workflow-restart:save']),
  });
  expect(result.reconciled).toEqual([]);
  expect(effects).toHaveLength(2);
});

test('an interrupted detached child is resolved explicitly instead of guessed successful', () => {
  const journal = RunJournal.fromRecords({
    scope: 'game-1',
    records: [
      { type: 'accepted', sequence: 1, at: 1, runId: 'parent', operationId: 'workflow.recipe', actor: { id: 'ai', kind: 'ai' }, sessionId: 's', scope: 'game-1', traceId: 't', attempt: 1, cancellable: false, retryable: true },
      { type: 'running', sequence: 2, at: 2, runId: 'parent' },
      { type: 'accepted', sequence: 1, at: 3, runId: 'child', operationId: 'asset.write', actor: { id: 'ai', kind: 'ai' }, sessionId: 's', scope: 'game-1', parentRunId: 'parent', traceId: 't', attempt: 1, cancellable: false, retryable: true },
      { type: 'running', sequence: 2, at: 4, runId: 'child' },
    ],
  });
  const result = reconcileRestartedRuns(journal, { committedEffectKeys: new Set() });
  expect(result).toMatchObject({ reconciled: ['parent', 'child'] });
  expect(journal.getRun('child')?.status).toBe('failed');
  expect(journal.getRun('child')?.error?.code).toBe('host-restarted');
});
