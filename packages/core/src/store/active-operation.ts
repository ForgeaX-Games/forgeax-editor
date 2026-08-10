// Current-authority UI operation seam.
//
// Business UI can live either beside the Runtime or in a disposable shell. It
// must not know which carrier is active, and it must never fall back to a shell
// shadow World. This adapter chooses the one current authority while preserving
// the Gateway operation payload and structured result.

import type { CommandError, EditorOp } from '../types';
import type { DispatchResult } from '../io/gateway';
import type { CommandOrigin } from '../io/gateway-history';
import {
  dispatchViewportRuntimeOperation,
  getViewportRuntimeClientSnapshot,
} from '../io/viewport-runtime-client';
import { gateway } from './gateway';

/**
 * Dispatch a UI operation to the active authority.
 *
 * Runtime-local callers retain the synchronous Gateway door. Shell callers send
 * the same operation through the connected Runtime capability. Gateway internals
 * that require an immediate inverse continue to use `gateway.dispatch` directly.
 */
export async function dispatchActiveEditorOperation(
  operation: EditorOp,
  origin: CommandOrigin = 'human',
): Promise<DispatchResult> {
  if (getViewportRuntimeClientSnapshot().status !== 'ready') {
    return gateway.dispatch(operation, origin);
  }
  const { kind, ...input } = operation;
  try {
    const response = await dispatchViewportRuntimeOperation(kind, input, {
      id: `editor-${origin}`,
      kind: origin,
    });
    if (response.error !== undefined) {
      return { ok: false, error: response.error as CommandError };
    }
    const run = response.result as {
      readonly status?: unknown;
      readonly result?: unknown;
      readonly error?: unknown;
    } | undefined;
    if (run?.status === 'failed' || run?.status === 'cancelled') {
      return {
        ok: false,
        error: (run.error ?? {
          code: 'operation-failed',
          hint: `Runtime operation "${kind}" ended ${String(run.status)}.`,
        }) as CommandError,
      };
    }
    const result = run?.result;
    if (
      result !== null
      && typeof result === 'object'
      && typeof (result as { ok?: unknown }).ok === 'boolean'
    ) {
      return result as DispatchResult;
    }
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'operation-failed',
        hint: cause instanceof Error ? cause.message : String(cause),
      },
    };
  }
}
