// Public, machine-readable recovery action validation and dispatch boundary.

import type { CommandError } from '../contracts/error';
import type { OperationRun } from '../contracts/run';
import type { WorkflowRecoveryAction, WorkflowRecoveryActionKind, WorkflowRun } from '../contracts/workflow';
import type { WorkflowStartResult } from './workflow-coordinator';

export interface WorkflowRecoveryRequest {
  readonly action: WorkflowRecoveryActionKind;
  readonly runId: string;
  readonly actionId: string;
  readonly newRunId?: string;
  readonly confirmationToken?: string;
}

export type WorkflowRecoveryResult =
  | {
    readonly ok: true;
    readonly action: WorkflowRecoveryAction;
    readonly run?: WorkflowRun;
    readonly recoveryRunId?: string;
    readonly recoveryRun?: OperationRun;
    readonly status: 'planned' | 'started';
  }
  | { readonly ok: false; readonly error: CommandError };

export interface WorkflowRecoveryPort {
  readonly getWorkflow: (runId: string) => WorkflowRun | undefined;
  readonly retryWorkflow: (runId: string, retryRunId: string) => WorkflowStartResult;
  readonly executeRecoveryAction?: (workflow: WorkflowRun, action: WorkflowRecoveryAction, request: WorkflowRecoveryRequest) => WorkflowRecoveryResult;
}

function error(code: string, hint: string, recoveryActions: readonly string[] = ['workflow.listRecipes']): { readonly ok: false; readonly error: CommandError } {
  return { ok: false, error: { code, hint, retryable: false, recoveryActions } };
}

export function isWorkflowRecoveryAction(value: unknown): value is WorkflowRecoveryAction {
  if (value === null || typeof value !== 'object') return false;
  const action = value as Partial<WorkflowRecoveryAction>;
  return typeof action.actionId === 'string' && typeof action.kind === 'string' && typeof action.runId === 'string' && typeof action.parentRunId === 'string' && typeof action.stepId === 'string' && typeof action.capabilityId === 'string' && typeof action.requiresConfirmation === 'boolean';
}

export function recoveryActionsForWorkflow(workflow: WorkflowRun): readonly WorkflowRecoveryAction[] {
  return Object.freeze(workflow.recoveryActions.filter(isWorkflowRecoveryAction));
}

export function recoverWorkflow(port: WorkflowRecoveryPort, request: WorkflowRecoveryRequest): WorkflowRecoveryResult {
  const workflow = port.getWorkflow(request.runId);
  if (workflow === undefined) return error('run-not-found', `workflow run "${request.runId}" is not known`, ['run.list']);
  const action = workflow.recoveryActions.find((candidate) => candidate.kind === request.action && candidate.actionId === request.actionId);
  if (action === undefined) return error('recovery-action-unavailable', `recovery action "${request.action}" is not available for this workflow`, ['workflow.get']);
  if (action.requiresConfirmation && request.confirmationToken !== `confirm:${action.actionId}`) {
    return error('confirmation-required', 'explicit confirmation is required before this recovery action', ['workflow.confirm']);
  }
  if (request.action === 'retry') {
    const started = port.retryWorkflow(request.runId, request.newRunId ?? `${request.runId}:retry`);
    if (!started.ok) return started;
    return { ok: true, action, status: 'started', run: started.run };
  }
  if (port.executeRecoveryAction !== undefined) return port.executeRecoveryAction(workflow, action, request);
  return error('recovery-action-unavailable', `recovery action "${request.action}" has no connected executor`, ['workflow.get']);
}
