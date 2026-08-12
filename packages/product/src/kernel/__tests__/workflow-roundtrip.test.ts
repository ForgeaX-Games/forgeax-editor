import { expect, test } from 'bun:test';

import { CapabilityRegistry } from '../capability-registry';
import { RunJournal } from '../run-journal';
import { WorkflowCoordinator, type WorkflowRecipe } from '../workflow-coordinator';

const recipe: WorkflowRecipe = {
  schemaVersion: 'workflow/v1', id: 'workflow.roundtrip', version: '1', failurePolicy: 'stop', steps: [
    { id: 'save', capabilityId: 'document.save', input: { sceneId: 'scene:one' } },
    { id: 'play', capabilityId: 'runtime.play', dependsOn: ['save'], input: { sceneId: 'scene:one' } },
    { id: 'stop', capabilityId: 'runtime.stop', dependsOn: ['play'], input: { sceneId: 'scene:one' } },
  ],
};

test('save, fresh reopen, Play, Stop and equivalent replay preserve one authored/resource fact', async () => {
  let effects = 0;
  const registry = new CapabilityRegistry();
  for (const [subject, verb] of [['document', 'save'], ['runtime', 'play'], ['runtime', 'stop']] as const) {
    registry.register({ id: `${subject}.${verb}`, kind: 'operation', version: '1', subject, verb, inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, availability: { available: true }, preconditions: [], recoveryActions: [], executor: { execute: (input) => ({ subject, verb, input, authoredRevision: 'revision:one', effect: ++effects }) } });
  }
  const journal = new RunJournal({ scope: 'game-1' });
  const coordinator = new WorkflowCoordinator({ registry, journal });
  const request = { actor: { id: 'ai', kind: 'ai' as const }, sessionId: 'session', scope: 'game-1', idempotencyKey: 'roundtrip-1' };
  const first = coordinator.startWorkflow(recipe, { ...request, runId: 'workflow-roundtrip-1' });
  if (!first.ok) throw new Error(first.error.hint);
  const firstTerminal = await first.completion;
  const reopened = RunJournal.fromRecords({ scope: 'game-1', records: journal.listRecords() });
  const resumed = new WorkflowCoordinator({ registry, journal: reopened }).startWorkflow(recipe, { ...request, runId: 'workflow-roundtrip-2' });
  if (!resumed.ok) throw new Error(resumed.error.hint);
  const secondTerminal = await resumed.completion;
  expect(firstTerminal).toMatchObject({ status: 'succeeded' });
  expect(secondTerminal).toMatchObject({ status: 'succeeded' });
  expect(effects).toBe(3);
  expect(reopened.listRecords().filter((record) => record.type === 'accepted')).toHaveLength(4);
});
