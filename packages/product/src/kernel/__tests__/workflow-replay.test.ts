import { expect, test } from 'bun:test';

import { CapabilityRegistry } from '../capability-registry';
import { RunJournal } from '../run-journal';
import { WorkflowCoordinator, type WorkflowRecipe } from '../workflow-coordinator';

const recipe: WorkflowRecipe = {
  schemaVersion: 'workflow/v1', id: 'workflow.replay', version: '1', failurePolicy: 'stop',
  steps: [{ id: 'write', capabilityId: 'asset.write', input: { id: 'asset:replay' } }],
};

test('replaying an equivalent recipe rebuilds the decision and does not repeat the effect', async () => {
  let effects = 0;
  const registry = new CapabilityRegistry();
  registry.register({ id: 'asset.write', kind: 'operation', version: '1', subject: 'asset', verb: 'write', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, outputSchema: { type: 'object' }, availability: { available: true }, preconditions: [], recoveryActions: [], executor: { execute: (input) => ({ committed: ++effects, input }) } });
  const journal = new RunJournal({ scope: 'game-1' });
  const first = new WorkflowCoordinator({ registry, journal }).startWorkflow(recipe, { runId: 'replay-1', actor: { id: 'ai', kind: 'ai' }, sessionId: 's', scope: 'game-1', idempotencyKey: 'replay-key' });
  if (!first.ok) throw new Error(first.error.hint);
  await first.completion;
  const restarted = new WorkflowCoordinator({ registry, journal: RunJournal.fromRecords({ scope: 'game-1', records: journal.listRecords() }) });
  const replay = restarted.startWorkflow(recipe, { runId: 'replay-2', actor: { id: 'ai', kind: 'ai' }, sessionId: 's', scope: 'game-1', idempotencyKey: 'replay-key' });
  expect(replay).toMatchObject({ ok: true, reused: true, runId: 'replay-1' });
  expect(effects).toBe(1);
});
