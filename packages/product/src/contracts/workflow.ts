// Schema-first workflow recipes. A recipe names existing capabilities; it
// never carries an executor closure or a second mutation boundary.

import type { CapabilityDescriptor } from './capability';
import type { CommandError } from './error';
import type { OperationRunStatus, RunActor } from './run';

export const WORKFLOW_SCHEMA_VERSION = 'workflow/v1' as const;

export type WorkflowFailurePolicy = 'stop' | 'continue' | 'compensate' | 'require-confirmation';
export type WorkflowRecoveryActionKind = 'retry' | 'continue' | 'stop' | 'compensate' | 'require-confirmation';

export interface WorkflowRecipeStep {
  readonly id: string;
  readonly capabilityId: string;
  readonly dependsOn?: readonly string[];
  readonly input?: unknown;
}

export interface WorkflowRecipe {
  readonly schemaVersion: typeof WORKFLOW_SCHEMA_VERSION;
  readonly id: string;
  readonly version: string;
  readonly failurePolicy: WorkflowFailurePolicy;
  readonly steps: readonly WorkflowRecipeStep[];
}

export interface ExpandedWorkflowRecipe extends WorkflowRecipe {
  readonly steps: readonly WorkflowRecipeStep[];
}

export interface WorkflowCapabilityLookup {
  readonly describe: (id: string) => CapabilityDescriptor | undefined;
}

export interface WorkflowRecoveryAction {
  readonly actionId: string;
  readonly kind: WorkflowRecoveryActionKind;
  readonly runId: string;
  readonly parentRunId: string;
  readonly stepId: string;
  readonly capabilityId: string;
  readonly requiresConfirmation: boolean;
}

export interface WorkflowChildRun {
  readonly runId: string;
  readonly parentRunId: string;
  readonly stepId: string;
  readonly capabilityId: string;
  readonly status: OperationRunStatus;
  readonly attempt: number;
  readonly actor: RunActor;
  readonly input?: unknown;
  readonly result?: unknown;
  readonly error?: CommandError;
  readonly effectKey: string;
  readonly recoveryActions: readonly WorkflowRecoveryAction[];
}

export interface WorkflowRun {
  readonly ok: true;
  readonly runId: string;
  readonly operationId: string;
  readonly recipeId: string;
  readonly status: OperationRunStatus;
  readonly actor: RunActor;
  readonly sessionId: string;
  readonly scope: string;
  readonly parentRunId?: string;
  readonly attempt: number;
  readonly result?: unknown;
  readonly error?: CommandError;
  readonly childRuns: readonly WorkflowChildRun[];
  readonly recoveryActions: readonly WorkflowRecoveryAction[];
}

export type WorkflowResult =
  | { readonly ok: true; readonly value: WorkflowRun }
  | { readonly ok: false; readonly error: CommandError };

export type WorkflowRecipeResult =
  | { readonly ok: true; readonly value: ExpandedWorkflowRecipe }
  | { readonly ok: false; readonly error: CommandError };

function workflowError(hint: string, recoveryActions: readonly string[] = ['editor.discover']): { readonly ok: false; readonly error: CommandError } {
  return {
    ok: false,
    error: {
      code: 'workflow-invalid',
      hint,
      retryable: false,
      recoveryActions,
      subjectRef: { kind: 'workflow', id: 'recipe' },
    },
  };
}

function matchesSchema(value: unknown, schema: CapabilityDescriptor['inputSchema'] | undefined): boolean {
  if (schema === null || schema === undefined || schema.type === undefined) return true;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'string') return typeof value === 'string';
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'array') return Array.isArray(value) && (schema.items === undefined || value.every((item) => matchesSchema(item, schema.items)));
  if (schema.type !== 'object' || value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  if (schema.required?.some((key) => !(key in object))) return false;
  return Object.entries(schema.properties ?? {}).every(([key, child]) => !(key in object) || matchesSchema(object[key], child));
}

function validateStepInput(step: WorkflowRecipeStep, descriptor: CapabilityDescriptor): boolean {
  return step.input === undefined || matchesSchema(step.input, descriptor.inputSchema);
}

function freezeStep(step: WorkflowRecipeStep): WorkflowRecipeStep {
  return Object.freeze({
    id: step.id,
    capabilityId: step.capabilityId,
    ...(step.dependsOn === undefined ? {} : { dependsOn: Object.freeze([...step.dependsOn]) }),
    ...(step.input === undefined ? {} : { input: step.input }),
  });
}

/** Validate and topologically sort a recipe with lexicographic tie breaking. */
export function expandWorkflowRecipe(recipe: WorkflowRecipe, capabilities: WorkflowCapabilityLookup): WorkflowRecipeResult {
  if (recipe.schemaVersion !== WORKFLOW_SCHEMA_VERSION || recipe.id.trim() === '' || recipe.version.trim() === '') return workflowError('workflow recipe schema or identity is invalid');
  if (recipe.steps.length === 0) return workflowError('workflow recipe must contain at least one step');
  const byId = new Map<string, WorkflowRecipeStep>();
  for (const step of recipe.steps) {
    if (step.id.trim() === '' || byId.has(step.id)) return workflowError(`workflow step id is duplicated or empty: ${step.id}`);
    const descriptor = capabilities.describe(step.capabilityId);
    if (descriptor === undefined) return workflowError(`workflow references unknown capability: ${step.capabilityId}`);
    if (!descriptor.availability.available) return workflowError(`workflow capability is unavailable: ${step.capabilityId}`);
    if (!validateStepInput(step, descriptor)) return workflowError(`workflow input does not match capability schema: ${step.id}`);
    byId.set(step.id, step);
  }

  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const step of recipe.steps) {
    const dependencies = step.dependsOn ?? [];
    if (new Set(dependencies).size !== dependencies.length || dependencies.includes(step.id)) return workflowError(`workflow dependency is invalid: ${step.id}`);
    indegree.set(step.id, dependencies.length);
    for (const dependency of dependencies) {
      if (!byId.has(dependency)) return workflowError(`workflow dependency is unknown: ${dependency}`);
      const next = outgoing.get(dependency) ?? [];
      next.push(step.id);
      outgoing.set(dependency, next);
    }
  }

  const ready = [...recipe.steps.filter((step) => indegree.get(step.id) === 0).map((step) => step.id)].sort();
  const ordered: WorkflowRecipeStep[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    const step = byId.get(id)!;
    ordered.push(freezeStep(step));
    for (const next of [...(outgoing.get(id) ?? [])].sort()) {
      const nextDegree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextDegree);
      if (nextDegree === 0) ready.push(next);
    }
    ready.sort();
  }
  if (ordered.length !== recipe.steps.length) return workflowError('workflow dependency graph contains a cycle');
  // Persist only the schema-first recipe fields. Spreading the caller's
  // object would allow an accidental executor/closure property to cross the
  // journal boundary and make restart recovery non-serializable.
  return {
    ok: true,
    value: Object.freeze({
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id: recipe.id,
      version: recipe.version,
      failurePolicy: recipe.failurePolicy,
      steps: Object.freeze(ordered),
    }),
  };
}
