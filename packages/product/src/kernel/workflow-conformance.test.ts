import { expect, test } from 'bun:test';

import { CapabilityRegistry } from '../kernel/capability-registry';
import { RunJournal } from './run-journal';
import { WorkflowCoordinator, type WorkflowRecipe } from './workflow-coordinator';

const U_IDS = ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8'] as const;

function recipes(): readonly WorkflowRecipe[] {
  return [
    { schemaVersion: 'workflow/v1', id: 'workflow.import-mount', version: '1', failurePolicy: 'stop', steps: [
      { id: 'import', capabilityId: 'asset.import', input: { subjectId: 'asset:one' } },
      { id: 'mount', capabilityId: 'scene.mount', dependsOn: ['import'], input: { subjectId: 'asset:one' } },
    ] },
    { schemaVersion: 'workflow/v1', id: 'workflow.material-roundtrip', version: '1', failurePolicy: 'stop', steps: [
      { id: 'create', capabilityId: 'material.create', input: { subjectId: 'material:one' } },
      { id: 'bind', capabilityId: 'material.bind', dependsOn: ['create'], input: { subjectId: 'material:one' } },
      { id: 'save', capabilityId: 'document.save', dependsOn: ['bind'], input: { documentId: 'scene:one' } },
      { id: 'play', capabilityId: 'runtime.play', dependsOn: ['save'], input: { sceneId: 'scene:one' } },
    ] },
    { schemaVersion: 'workflow/v1', id: 'workflow.batch-move', version: '1', failurePolicy: 'stop', steps: [
      { id: 'preflight', capabilityId: 'asset.preflight', input: { subjectId: 'asset:one' } },
      { id: 'move', capabilityId: 'asset.move', dependsOn: ['preflight'], input: { subjectId: 'asset:one' } },
    ] },
    { schemaVersion: 'workflow/v1', id: 'workflow.failure-recovery', version: '1', failurePolicy: 'continue', steps: [
      { id: 'failed', capabilityId: 'asset.replace', input: { subjectId: 'asset:broken' } },
      { id: 'recover', capabilityId: 'asset.restore', input: { subjectId: 'asset:broken' } },
    ] },
  ];
}

function coordinator(host: 'bun' | 'edit'): WorkflowCoordinator {
  const registry = new CapabilityRegistry();
  const ids = [...new Set(recipes().flatMap((recipe) => recipe.steps.map((step) => step.capabilityId)))];
  for (const id of ids) {
    const [subject, verb] = id.split('.');
    registry.register({
      id, kind: 'operation', version: '1', subject: subject ?? 'asset', verb: verb ?? 'run',
      inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, availability: { available: true }, preconditions: [], recoveryActions: [],
      executor: { execute: (input) => ({ host, id, input, committed: true }) },
    });
  }
  return new WorkflowCoordinator({ registry, journal: new RunJournal({ scope: host }) });
}

test('the four public workflows use the same product adapter in UI-free and UI-hosted fixtures', async () => {
  const reports = await Promise.all(recipes().map(async (recipe, index) => {
    const bun = coordinator('bun').startWorkflow(recipe, { runId: `bun-${index}`, actor: { id: 'ai', kind: 'ai' }, sessionId: 's', scope: 'bun' });
    const edit = coordinator('edit').startWorkflow(recipe, { runId: `edit-${index}`, actor: { id: 'human', kind: 'human' }, sessionId: 's', scope: 'edit' });
    if (!bun.ok || !edit.ok) throw new Error('workflow was not accepted');
    return { bun: await bun.completion, edit: await edit.completion };
  }));
  expect(reports).toHaveLength(4);
  for (const report of reports) {
    expect(report.bun.status).toBe('succeeded');
    expect(report.edit.status).toBe('succeeded');
    expect(report.bun.childRuns.map((run) => run.stepId)).toEqual(report.edit.childRuns.map((run) => run.stepId));
  }
  expect(U_IDS).toHaveLength(8);
});
