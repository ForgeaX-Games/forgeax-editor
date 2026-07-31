// source-file-delete-status — bounded terminal read model for the asynchronous
// deleteSourceFile session op (editor data-operation-view convergence M1).

import type { CommandError } from '../types';
import type { OperationRun } from '@forgeax/editor-product';

export type SourceFileDeleteStatus =
  | { phase: 'pending'; path: string; runId?: string }
  | { phase: 'deleted'; path: string; runId?: string }
  | { phase: 'failed'; path: string; error: CommandError; runId?: string };

export function sourceFileDeletePath(run: OperationRun): string | null {
  if (run.operationId !== 'deleteSourceFile' || run.input === null || typeof run.input !== 'object') return null;
  const path = (run.input as { readonly path?: unknown }).path;
  return typeof path === 'string' ? path : null;
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
