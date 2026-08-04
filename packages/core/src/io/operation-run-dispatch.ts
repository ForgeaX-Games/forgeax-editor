// Gateway-owned OperationRun acceptance for request-correlated session ops.
//
// This helper only accepts a run in the Gateway registry. It does not retain a
// parallel request map or interpret terminal outcomes; the registry remains
// the sole lifecycle owner.

import type { EditorOp } from '../types';
import type { CommandOrigin } from './gateway-history';
import type { RunJournalAcceptResult } from '@forgeax/editor-product';
import {
  OperationRunRegistry,
} from './operation-runs';

export interface OperationRunDispatchOptions {
  readonly registry: OperationRunRegistry;
  readonly command: EditorOp;
  readonly origin: CommandOrigin;
  readonly operationId: string;
  readonly requestId: string;
  readonly cancellable: boolean;
  readonly retryable: boolean;
  readonly retryOfRequestId?: string;
}

function runActor(origin: CommandOrigin): { readonly id: string; readonly kind: 'human' | 'ai' } {
  return origin === 'ai' ? { id: 'ai', kind: 'ai' } : { id: 'human', kind: 'human' };
}

export function acceptOperationRun(
  options: OperationRunDispatchOptions,
): RunJournalAcceptResult {
  const { registry, command, origin, operationId, requestId, retryable, cancellable } = options;
  const retrySource = options.retryOfRequestId === undefined
    ? null
    : registry.getRunResult(options.retryOfRequestId);
  if (retrySource !== null && !retrySource.ok) return retrySource;
  if (retrySource !== null && (retrySource.value.status !== 'failed' || !retrySource.value.retryable)) {
    return {
      ok: false,
      error: {
        code: 'operation-not-retryable',
        hint: 'Only a failed retryable operation run can be retried.',
        current: retrySource.value,
        retryable: false,
        recoveryActions: ['run.get'],
      },
    };
  }
  return registry.acceptOperation(requestId, { ...command }, runActor(origin), {
    operationId,
    cancellable,
    retryable,
    ...(retrySource === null ? {} : {
      parentRunId: retrySource.value.runId,
      attempt: retrySource.value.attempt + 1,
    }),
  });
}
