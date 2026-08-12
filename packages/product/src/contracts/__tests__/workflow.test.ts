import { expect, test } from 'bun:test';

import { capabilityId } from '../capability';
import { CapabilityRegistry } from '../../kernel/capability-registry';
import {
  expandWorkflowRecipe,
  type WorkflowRecipe,
} from '../workflow';

function registry(): CapabilityRegistry {
  const value = new CapabilityRegistry();
  for (const verb of ['import', 'mount', 'save']) {
    value.register({
      id: capabilityId('asset', verb),
      kind: 'operation',
      version: '1',
      subject: 'asset',
      verb,
      inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      outputSchema: { type: 'object' },
      availability: { available: true },
      preconditions: [],
      recoveryActions: [],
      executor: { execute: (input) => input },
    });
  }
  return value;
}

function recipe(overrides: Partial<WorkflowRecipe> = {}): WorkflowRecipe {
  return {
    schemaVersion: 'workflow/v1',
    id: 'recipe.basic',
    version: '1',
    failurePolicy: 'stop',
    steps: [
      { id: 'import', capabilityId: 'asset.import', input: { id: 'mesh' } },
      { id: 'mount', capabilityId: 'asset.mount', dependsOn: ['import'], input: { id: 'mesh' } },
      { id: 'save', capabilityId: 'asset.save', dependsOn: ['mount'], input: { id: 'mesh' } },
    ],
    ...overrides,
  };
}

test('workflow recipes expand into a deterministic dependency order', () => {
  const result = expandWorkflowRecipe(recipe(), registry());

  expect(result).toMatchObject({ ok: true });
  if (!result.ok) return;
  expect(result.value.steps.map((step) => step.id)).toEqual(['import', 'mount', 'save']);
  expect(result.value.steps.every((step) => step.capabilityId.includes('.'))).toBe(true);
});

test('workflow recipe validation rejects unknown capabilities, cycles, and invalid input', () => {
  const unknown = expandWorkflowRecipe(recipe({
    steps: [{ id: 'missing', capabilityId: 'asset.missing', input: { id: 'mesh' } }],
  }), registry());
  expect(unknown).toMatchObject({ ok: false, error: { code: 'workflow-invalid' } });
  if (!unknown.ok) expect(unknown.error.recoveryActions).toContain('editor.discover');

  const cycle = expandWorkflowRecipe(recipe({
    steps: [
      { id: 'a', capabilityId: 'asset.import', dependsOn: ['b'], input: { id: 'a' } },
      { id: 'b', capabilityId: 'asset.mount', dependsOn: ['a'], input: { id: 'b' } },
    ],
  }), registry());
  expect(cycle).toMatchObject({ ok: false, error: { code: 'workflow-invalid' } });

  const invalidInput = expandWorkflowRecipe(recipe({
    steps: [{ id: 'bad', capabilityId: 'asset.import', input: { id: 7 } }],
  }), registry());
  expect(invalidInput).toMatchObject({ ok: false, error: { code: 'workflow-invalid' } });
});

test('recipe data is schema-first and cannot carry an executor closure', () => {
  const candidate = { ...recipe(), executor: () => 'must-not-persist' } as unknown as WorkflowRecipe & { readonly executor: () => string };
  expect(JSON.stringify(candidate)).toContain('asset.import');
  expect(Object.values(candidate.steps).some((step) => 'execute' in step)).toBe(false);
  const expanded = expandWorkflowRecipe(candidate, registry());
  expect(expanded).toMatchObject({ ok: true });
  if (expanded.ok) expect('executor' in expanded.value).toBe(false);
});
