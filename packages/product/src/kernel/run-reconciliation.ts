// Crash reconciliation policy for accepted or running OperationRuns.

import type { CommandError } from '../contracts/error';
import type { OperationRun, TerminalRunStatus } from '../contracts/run';
import type { RunJournal } from './run-journal';

export interface ReconciliationResolution {
  readonly state: TerminalRunStatus;
  readonly result?: unknown;
  readonly error?: CommandError;
}

export interface ReconciliationContext {
  readonly run: OperationRun;
}

export interface ReconciliationResult {
  readonly ok: true;
  readonly reconciled: readonly string[];
}

export interface RestartReconciliationOptions {
  readonly committedEffectKeys: ReadonlySet<string>;
}

export interface RestartReconciliationResult {
  readonly reconciled: readonly string[];
  readonly preserved: readonly string[];
}

/** Resolve only non-terminal runs after restart; terminal history is untouched. */
export function reconcileRestartedRuns(
  journal: RunJournal,
  options: RestartReconciliationOptions,
): RestartReconciliationResult {
  const reconciled: string[] = [];
  const preserved: string[] = [];
  const runs = [...journal.listRuns()].sort((left, right) => {
    const depth = (run: OperationRun): number => run.parentRunId === undefined ? 0 : 1;
    return depth(left) - depth(right) || left.runId.localeCompare(right.runId);
  });
  for (const run of runs) {
    if (run.status !== 'accepted' && run.status !== 'running') continue;
    const effect = Object.entries(run.effectResults).find(([key]) => options.committedEffectKeys.has(key));
    const event = effect === undefined
      ? {
        type: 'failed' as const,
        runId: run.runId,
        at: Date.now(),
        error: {
          code: 'host-restarted',
          hint: 'The host restarted before this run had a durable committed effect.',
          retryable: true,
          recoveryActions: ['workflow.retry', 'workflow.stop'],
        },
      }
      : { type: 'succeeded' as const, runId: run.runId, at: Date.now(), result: effect[1] };
    const applied = journal.append(event);
    if (applied.ok) reconciled.push(run.runId);
    else preserved.push(run.runId);
  }
  return { reconciled: Object.freeze(reconciled), preserved: Object.freeze(preserved) };
}

export function reconcileOperationRuns(
  runs: readonly OperationRun[],
  resolve: (context: ReconciliationContext) => ReconciliationResolution,
): readonly { readonly run: OperationRun; readonly resolution: ReconciliationResolution }[] {
  return runs
    .filter((run) => run.status === 'accepted' || run.status === 'running')
    .map((run) => Object.freeze({ run, resolution: resolve({ run }) }));
}
