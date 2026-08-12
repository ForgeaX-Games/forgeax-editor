import { expect, test } from 'bun:test';

import { CapabilityRegistry } from '../capability-registry';
import { RunJournal } from '../run-journal';
import {
  WorkflowCoordinator,
  type WorkflowRecipe,
} from '../workflow-coordinator';

function makeRecipe(): WorkflowRecipe {
  return {
    schemaVersion: 'workflow/v1',
    id: 'recipe.order',
    version: '1',
    failurePolicy: 'stop',
    steps: [
      { id: 'first', capabilityId: 'asset.first', input: { id: 'one' } },
      { id: 'second', capabilityId: 'asset.second', dependsOn: ['first'], input: { id: 'two' } },
    ],
  };
}

function makeRegistry(calls: string[]): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  for (const verb of ['first', 'second']) {
    registry.register({
      id: `asset.${verb}`,
      kind: 'operation',
      version: '1',
      subject: 'asset',
      verb,
      inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      outputSchema: { type: 'object' },
      availability: { available: true },
      preconditions: [],
      recoveryActions: [],
      executor: { execute: (input) => { calls.push(verb); return { verb, input }; } },
    });
  }
  return registry;
}

test('workflow coordinator creates one deterministic parent and child run per recipe step', async () => {
  const calls: string[] = [];
  const coordinator = new WorkflowCoordinator({
    registry: makeRegistry(calls),
    journal: new RunJournal({ scope: 'game-1', now: (() => { let value = 0; return () => ++value; })() }),
  });
  const started = coordinator.startWorkflow(makeRecipe(), {
    runId: 'workflow-1',
    actor: { id: 'ai-1', kind: 'ai' },
    sessionId: 'session-1',
    scope: 'game-1',
    idempotencyKey: 'workflow-key',
  });

  expect(started).toMatchObject({ ok: true, runId: 'workflow-1' });
  if (!started.ok) return;
  const terminal = await started.completion;
  expect(terminal).toMatchObject({ ok: true, status: 'succeeded' });
  expect(calls).toEqual(['first', 'second']);
  expect(coordinator.listChildRuns('workflow-1').map((run) => run.stepId)).toEqual(['first', 'second']);
  expect(coordinator.journal.listEvents('workflow-1').map((event) => event.type)).toEqual(['accepted', 'running', 'succeeded']);
});

test('equivalent workflow dispatch is idempotent and does not repeat child effects', async () => {
  const calls: string[] = [];
  const coordinator = new WorkflowCoordinator({ registry: makeRegistry(calls), journal: new RunJournal({ scope: 'game-1' }) });
  const request = {
    actor: { id: 'ai-1', kind: 'ai' as const },
    sessionId: 'session-1',
    scope: 'game-1',
    idempotencyKey: 'same-workflow',
  };
  const first = coordinator.startWorkflow(makeRecipe(), { ...request, runId: 'workflow-1' });
  if (!first.ok) throw new Error(first.error.hint);
  await first.completion;
  const second = coordinator.startWorkflow(makeRecipe(), { ...request, runId: 'workflow-2' });
  expect(second).toMatchObject({ ok: true, reused: true, runId: 'workflow-1' });
  expect(calls).toEqual(['first', 'second']);
});
