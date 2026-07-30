// Deterministic workflow coordinator over the existing capability executor and
// OperationRun journal. It creates no UI/AI-specific action or mutation path.

import type { CommandError } from '../contracts/error';
import {
  expandWorkflowRecipe,
  type ExpandedWorkflowRecipe,
  type WorkflowChildRun,
  type WorkflowFailurePolicy,
  type WorkflowRecoveryAction,
  type WorkflowRecipe,
  type WorkflowRun,
} from '../contracts/workflow';
import type { CapabilityRegistry } from './capability-registry';
import { RunJournal } from './run-journal';
import type { OperationRunRequest, OperationRun } from '../contracts/run';
import type { WorkflowRecoveryRequest, WorkflowRecoveryResult } from './workflow-recovery';

export type { WorkflowRecipe, WorkflowFailurePolicy } from '../contracts/workflow';

export interface WorkflowStartRequest {
  readonly runId: string;
  readonly actor: OperationRunRequest['actor'];
  readonly sessionId: string;
  readonly scope: string;
  readonly input?: unknown;
  readonly idempotencyKey?: string;
  readonly attempt?: number;
  readonly parentRunId?: string;
}

export interface WorkflowStartSuccess {
  readonly ok: true;
  readonly runId: string;
  readonly reused: boolean;
  readonly run: WorkflowRun;
  readonly completion: Promise<WorkflowRun>;
}

export type WorkflowStartResult = WorkflowStartSuccess | { readonly ok: false; readonly error: CommandError };

export interface WorkflowCoordinatorOptions {
  readonly registry: CapabilityRegistry;
  readonly journal: RunJournal;
}

function failure(code: string, hint: string, recoveryActions: readonly string[] = []): CommandError {
  return { code, hint, retryable: code === 'host-restarted' || code === 'resource-failed', recoveryActions };
}

function isFailedResult(value: unknown): value is { readonly ok: false; readonly error?: CommandError } {
  return typeof value === 'object' && value !== null && 'ok' in value && (value as { ok?: unknown }).ok === false;
}

function childAction(kind: WorkflowRecoveryAction['kind'], child: WorkflowChildRun): WorkflowRecoveryAction {
  return Object.freeze({
    actionId: `workflow.${kind}:${child.runId}`,
    kind,
    runId: child.runId,
    parentRunId: child.parentRunId,
    stepId: child.stepId,
    capabilityId: child.capabilityId,
    requiresConfirmation: kind === 'compensate' || kind === 'require-confirmation',
  });
}

function childStepId(parentRunId: string, stepId: string, attempt: number): string {
  return `${parentRunId}:${stepId}:attempt:${attempt}`;
}

export class WorkflowCoordinator {
  readonly journal: RunJournal;
  private readonly registry: CapabilityRegistry;
  private readonly recipes = new Map<string, ExpandedWorkflowRecipe>();

  constructor(options: WorkflowCoordinatorOptions) {
    this.registry = options.registry;
    this.journal = options.journal;
  }

  startWorkflow(recipe: WorkflowRecipe, request: WorkflowStartRequest): WorkflowStartResult {
    const expanded = expandWorkflowRecipe(recipe, this.registry);
    if (!expanded.ok) return expanded;
    const parentOperationId = `workflow.${expanded.value.id}`;
    const accepted = this.journal.accept({
      runId: request.runId,
      operationId: parentOperationId,
      actor: request.actor,
      sessionId: request.sessionId,
      scope: request.scope,
      // Persist the schema-only recipe with the parent run. A restarted
      // coordinator can therefore rebuild the same workflow without a
      // process-local recipe registry or an executor closure.
      input: { recipe: expanded.value, recipeId: recipe.id, value: request.input },
      ...(request.parentRunId === undefined ? {} : { parentRunId: request.parentRunId }),
      traceId: request.runId,
      ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
      attempt: request.attempt ?? 1,
      cancellable: false,
      retryable: true,
    });
    if (!accepted.ok) return accepted;
    this.recipes.set(accepted.runId, expanded.value);
    const current = this.workflowView(accepted.runId, expanded.value);
    if (accepted.reused) return { ok: true, runId: accepted.runId, reused: true, run: current, completion: Promise.resolve(current) };

    const completion = this.execute(expanded.value, accepted.runId, request);
    return { ok: true, runId: accepted.runId, reused: false, run: current, completion };
  }

  retryWorkflow(runId: string, retryRunId: string): WorkflowStartResult {
    const original = this.journal.getRun(runId);
    const recipe = this.recipeForRun(runId);
    if (original === undefined) return { ok: false, error: failure('run-not-found', `workflow run "${runId}" is not known`, ['run.list']) };
    if (recipe === undefined) return { ok: false, error: failure('workflow-recovery-unavailable', 'The persisted workflow recipe is unavailable or invalid.', ['workflow.listRecipes']) };
    const existingRetryRun = this.journal.getRun(retryRunId);
    if (existingRetryRun !== undefined) {
      const sameRetry = existingRetryRun.operationId === `workflow.${recipe.id}` && existingRetryRun.parentRunId === original.runId;
      if (!sameRetry) return { ok: false, error: failure('recovery-run-conflict', `Recovery run id "${retryRunId}" is already used by another run.`, ['workflow.get']) };
      const reused = this.workflowView(retryRunId, recipe);
      return { ok: true, runId: retryRunId, reused: true, run: reused, completion: Promise.resolve(reused) };
    }
    if (original.status !== 'failed') return { ok: false, error: failure('run-not-retryable', 'Only failed workflow runs can create a retry attempt.', ['workflow.get']) };
    const input = original.input as { value?: unknown } | undefined;
    return this.startWorkflow(recipe, {
      runId: retryRunId,
      actor: original.actor,
      sessionId: original.sessionId,
      scope: original.scope,
      input: input?.value,
      parentRunId: original.runId,
      attempt: original.attempt + 1,
      ...(original.idempotencyKey === undefined ? {} : { idempotencyKey: `${original.idempotencyKey}:attempt:${original.attempt + 1}` }),
    });
  }

  getWorkflow(runId: string): WorkflowRun | undefined {
    const recipe = this.recipeForRun(runId);
    const run = this.journal.getRun(runId);
    if (run === undefined) return undefined;
    return this.workflowView(runId, recipe);
  }

  listChildRuns(parentRunId: string): readonly WorkflowChildRun[] {
    const recipe = this.recipeForRun(parentRunId);
    return this.childRuns(parentRunId, recipe);
  }

  private recipeForRun(runId: string): ExpandedWorkflowRecipe | undefined {
    const cached = this.recipes.get(runId);
    if (cached !== undefined) return cached;
    const run = this.journal.getRun(runId);
    const persisted = run?.input;
    if (persisted === null || typeof persisted !== 'object' || Array.isArray(persisted)) return undefined;
    const recipe = (persisted as { readonly recipe?: unknown }).recipe;
    if (recipe === null || typeof recipe !== 'object' || Array.isArray(recipe)) return undefined;
    const expanded = expandWorkflowRecipe(recipe as WorkflowRecipe, this.registry);
    if (!expanded.ok) return undefined;
    this.recipes.set(runId, expanded.value);
    return expanded.value;
  }

  private async execute(recipe: ExpandedWorkflowRecipe, parentRunId: string, request: WorkflowStartRequest): Promise<WorkflowRun> {
    this.journal.append({ type: 'running', runId: parentRunId, at: Date.now() });
    const completed: string[] = [];
    const failed: WorkflowChildRun[] = [];
    for (const step of recipe.steps) {
      if ((step.dependsOn ?? []).some((dependency) => failed.some((child) => child.stepId === dependency))) continue;
      const childId = childStepId(parentRunId, step.id, request.attempt ?? 1);
      const accepted = this.journal.accept({
        runId: childId,
        operationId: step.capabilityId,
        actor: request.actor,
        sessionId: request.sessionId,
        scope: request.scope,
        input: step.input,
        parentRunId,
        traceId: request.runId,
        idempotencyKey: `${parentRunId}:${step.id}`,
        attempt: request.attempt ?? 1,
        cancellable: false,
        retryable: true,
      });
      if (!accepted.ok) {
        failed.push(this.childView(parentRunId, step.id, step.capabilityId, childId, request.actor, step.input, accepted.error, recipe.failurePolicy));
        break;
      }
      if (accepted.reused) {
        const reused = this.childViewFromRun(parentRunId, step.id, accepted.run, recipe.failurePolicy);
        if (reused.status === 'failed') failed.push(reused); else completed.push(step.id);
        continue;
      }
      this.journal.append({ type: 'running', runId: childId, at: Date.now() });
      try {
        const executed = await this.registry.execute(step.capabilityId, step.input, { host: 'bun' });
        if (!executed.ok) {
          const child = this.finishChildFailure(parentRunId, step.id, step.capabilityId, childId, request.actor, step.input, executed.error, recipe.failurePolicy);
          failed.push(child);
          if (recipe.failurePolicy !== 'continue') break;
          continue;
        }
        if (isFailedResult(executed.result)) {
          const child = this.finishChildFailure(parentRunId, step.id, step.capabilityId, childId, request.actor, step.input, executed.result.error ?? failure('workflow-child-failed', 'The child capability returned a failed result.', ['workflow.retry']), recipe.failurePolicy);
          failed.push(child);
          if (recipe.failurePolicy !== 'continue') break;
          continue;
        }
        this.journal.append({ type: 'effect-result', runId: childId, at: Date.now(), effectKey: `${parentRunId}:${step.id}`, result: executed.result });
        this.journal.append({ type: 'succeeded', runId: childId, at: Date.now(), result: executed.result });
        completed.push(step.id);
      } catch (cause) {
        const child = this.finishChildFailure(parentRunId, step.id, step.capabilityId, childId, request.actor, step.input, failure('workflow-child-failed', cause instanceof Error ? cause.message : 'The child capability failed.', ['workflow.retry']), recipe.failurePolicy);
        failed.push(child);
        if (recipe.failurePolicy !== 'continue') break;
      }
    }
    const children = this.childRuns(parentRunId, recipe);
    const firstFailure = failed[0] ?? children.find((child) => child.status === 'failed');
    if (firstFailure !== undefined && recipe.failurePolicy !== 'continue') {
      const error = this.parentFailure(recipe.failurePolicy, firstFailure);
      this.journal.append({ type: 'failed', runId: parentRunId, at: Date.now(), error });
    } else {
      this.journal.append({ type: 'succeeded', runId: parentRunId, at: Date.now(), result: { completedStepIds: completed, failedStepIds: failed.map((child) => child.stepId), continued: failed.length > 0 } });
    }
    return this.workflowView(parentRunId, recipe);
  }

  private parentFailure(policy: WorkflowFailurePolicy, child: WorkflowChildRun): CommandError {
    if (policy === 'compensate') return failure('workflow-compensation-required', 'The failed child requires an explicit compensation run.', ['workflow.get']);
    if (policy === 'require-confirmation') return { ...failure('confirmation-required', 'The failed child requires explicit recovery confirmation.', ['workflow.get']), confirmation: { required: true } };
    return failure('workflow-child-failed', `Workflow child ${child.stepId} failed.`, ['workflow.retry', 'workflow.recover']);
  }

  private finishChildFailure(parentRunId: string, stepId: string, capabilityId: string, runId: string, actor: OperationRunRequest['actor'], input: unknown, error: CommandError, policy: WorkflowFailurePolicy): WorkflowChildRun {
    this.journal.append({ type: 'failed', runId, at: Date.now(), error });
    return this.childView(parentRunId, stepId, capabilityId, runId, actor, input, error, policy);
  }

  private childView(parentRunId: string, stepId: string, capabilityId: string, runId: string, actor: OperationRunRequest['actor'], input: unknown, error: CommandError, policy: WorkflowFailurePolicy): WorkflowChildRun {
    const child: WorkflowChildRun = { runId, parentRunId, stepId, capabilityId, status: 'failed', attempt: 1, actor, ...(input === undefined ? {} : { input }), error, effectKey: `${parentRunId}:${stepId}`, recoveryActions: [] };
    const policyAction: WorkflowRecoveryAction['kind'] = policy === 'compensate' ? 'compensate' : policy === 'require-confirmation' ? 'require-confirmation' : policy === 'continue' ? 'continue' : 'stop';
    const actions = [childAction('retry', child), childAction('stop', child), ...(policyAction === 'stop' ? [] : [childAction(policyAction, child)])];
    return Object.freeze({ ...child, recoveryActions: Object.freeze(actions) });
  }

  private childViewFromRun(parentRunId: string, stepId: string, run: OperationRun, policy: WorkflowFailurePolicy): WorkflowChildRun {
    const child: WorkflowChildRun = { runId: run.runId, parentRunId, stepId, capabilityId: run.operationId, status: run.status, attempt: run.attempt, actor: run.actor, ...(run.input === undefined ? {} : { input: run.input }), ...(run.result === undefined ? {} : { result: run.result }), ...(run.error === undefined ? {} : { error: run.error }), effectKey: `${parentRunId}:${stepId}`, recoveryActions: [] };
    if (run.status !== 'failed') return Object.freeze(child);
    const policyAction: WorkflowRecoveryAction['kind'] = policy === 'compensate' ? 'compensate' : policy === 'require-confirmation' ? 'require-confirmation' : policy === 'continue' ? 'continue' : 'stop';
    const actions = [childAction('retry', child), childAction('stop', child), ...(policyAction === 'stop' ? [] : [childAction(policyAction, child)])];
    return Object.freeze({ ...child, recoveryActions: Object.freeze(actions) });
  }

  private childRuns(parentRunId: string, recipe?: ExpandedWorkflowRecipe): readonly WorkflowChildRun[] {
    const steps = recipe?.steps ?? [];
    const byChildId = new Map<string, WorkflowChildRun>();
    for (const record of this.journal.listRecords()) {
      if (record.type !== 'accepted' || record.parentRunId !== parentRunId) continue;
      const step = steps.find((candidate) => record.runId.startsWith(`${parentRunId}:${candidate.id}:`));
      if (step === undefined) continue;
      const run = this.journal.getRun(record.runId);
      if (run !== undefined) byChildId.set(run.runId, this.childViewFromRun(parentRunId, step.id, run, recipe?.failurePolicy ?? 'stop'));
    }
    const order = new Map((recipe?.steps ?? []).map((step, index) => [step.id, index]));
    return Object.freeze([...byChildId.values()].sort((left, right) => (order.get(left.stepId) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.stepId) ?? Number.MAX_SAFE_INTEGER)));
  }

  private workflowView(runId: string, recipe?: ExpandedWorkflowRecipe): WorkflowRun {
    const run = this.journal.getRun(runId);
    if (run === undefined) throw new Error(`workflow run not found: ${runId}`);
    const children = this.childRuns(runId, recipe);
    return Object.freeze({
      ok: true as const,
      runId: run.runId,
      operationId: run.operationId,
      recipeId: recipe?.id ?? run.operationId.replace(/^workflow\./, ''),
      status: run.status,
      actor: run.actor,
      sessionId: run.sessionId,
      scope: run.scope,
      ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
      attempt: run.attempt,
      ...(run.result === undefined ? {} : { result: run.result }),
      ...(run.error === undefined ? {} : { error: run.error }),
      childRuns: children,
      recoveryActions: Object.freeze(children.flatMap((child) => child.recoveryActions)),
    });
  }

  executeRecoveryAction(workflow: WorkflowRun, action: WorkflowRecoveryAction, request: WorkflowRecoveryRequest): WorkflowRecoveryResult {
    if (action.kind === 'compensate' || action.kind === 'require-confirmation') {
      return { ok: false, error: failure('recovery-action-unavailable', `No safe executor is connected for recovery action "${action.kind}".`, ['workflow.get']) };
    }
    const recoveryRunId = request.newRunId ?? `${workflow.runId}:recovery:${action.kind}:${encodeURIComponent(action.actionId)}`;
    const operationId = `workflow.recovery.${action.kind}`;
    const input = { actionId: action.actionId, targetRunId: action.runId, targetStepId: action.stepId };
    const existing = this.journal.getRun(recoveryRunId);
    if (existing !== undefined) {
      const sameRecovery = existing.operationId === operationId
        && existing.parentRunId === workflow.runId
        && JSON.stringify(existing.input) === JSON.stringify(input);
      if (!sameRecovery) return { ok: false, error: failure('recovery-run-conflict', `Recovery run id "${recoveryRunId}" is already used by another recovery action.`, ['workflow.get']) };
      return { ok: true, action, status: 'started', run: workflow, recoveryRunId, recoveryRun: existing };
    }
    const accepted = this.journal.accept({
      runId: recoveryRunId,
      operationId,
      actor: workflow.actor,
      sessionId: workflow.sessionId,
      scope: workflow.scope,
      input,
      parentRunId: workflow.runId,
      traceId: workflow.runId,
      idempotencyKey: `workflow-recovery:${action.actionId}:${recoveryRunId}`,
      cancellable: false,
      retryable: false,
    });
    if (!accepted.ok) return accepted;
    if (accepted.reused) return { ok: true, action, status: 'started', run: workflow, recoveryRunId, recoveryRun: accepted.run };
    const running = this.journal.append({ type: 'running', runId: recoveryRunId, at: Date.now() });
    if (!running.ok) return running;
    const terminal = this.journal.append({ type: 'succeeded', runId: recoveryRunId, at: Date.now(), result: { actionId: action.actionId, targetRunId: action.runId, state: action.kind === 'stop' ? 'stopped' : 'continued' } });
    if (!terminal.ok) return terminal;
    return { ok: true, action, status: 'started', run: workflow, recoveryRunId, recoveryRun: terminal.value };
  }
}
