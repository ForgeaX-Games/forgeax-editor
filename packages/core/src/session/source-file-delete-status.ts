// source-file-delete-status — bounded terminal read model for the asynchronous
// deleteSourceFile session op (editor data-operation-view convergence M1).

import type { CommandError } from '../types';
import type { OperationRun } from '@forgeax/editor-product';

export type SourceFileDeleteStatus =
  | { phase: 'pending'; path: string; runId?: string }
  | { phase: 'deleted'; path: string; runId?: string }
  | { phase: 'failed'; path: string; error: CommandError; runId?: string };

const MAX_STATUS_ENTRIES = 64;
const statuses = new Map<string, SourceFileDeleteStatus>();

function remember(requestId: string, status: SourceFileDeleteStatus): void {
  statuses.delete(requestId);
  statuses.set(requestId, status);
  while (statuses.size > MAX_STATUS_ENTRIES) {
    const oldest = statuses.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    statuses.delete(oldest);
  }
}

export function markSourceFileDeletePending(requestId: string, path: string): void {
  remember(requestId, { phase: 'pending', path });
}

export function markSourceFileDeleted(requestId: string, path: string): void {
  remember(requestId, { phase: 'deleted', path });
}

export function markSourceFileDeleteFailed(requestId: string, path: string, error: CommandError): void {
  remember(requestId, { phase: 'failed', path, error });
}

export function getSourceFileDeleteStatus(requestId: string): SourceFileDeleteStatus | null {
  return statuses.get(requestId) ?? null;
}

/** A request id identifies one accepted asynchronous command for its whole
 * lifetime. Reusing it would let an older completion overwrite the newer
 * command's terminal state, so callers must mint a fresh id for a retry. */
export function hasSourceFileDeleteStatus(requestId: string): boolean {
  return statuses.has(requestId);
}

/** Test-only reset; not exported from the public barrel. */
export function clearSourceFileDeleteStatuses(): void {
  statuses.clear();
}

/**
 * Compatibility projection for callers that still ask about a delete by path.
 * OperationRun is the lifecycle owner; this function does not create or mutate
 * a second terminal state.
 */
export function projectSourceFileDeleteStatus(
  run: OperationRun,
  path: string,
): SourceFileDeleteStatus {
  if (run.status === 'succeeded') return { phase: 'deleted', path, runId: run.runId };
  if (run.status === 'failed' || run.status === 'cancelled') {
    const runError = run.error;
    return {
      phase: 'failed',
      path,
      runId: run.runId,
      error: runError === undefined ? {
        code: (run.status === 'cancelled' ? 'run-cancelled' : 'run-failed') as CommandError['code'],
        hint: `The source file delete run ${run.status}.`,
      } : {
        code: runError.code as CommandError['code'],
        hint: runError.hint,
      },
    };
  }
  return { phase: 'pending', path, runId: run.runId };
}
