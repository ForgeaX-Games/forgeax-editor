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
  refreshViewportRuntimeSelectionSnapshot,
} from '../io/viewport-runtime-client';

const SELECTION_OPERATIONS = new Set([
  'setSelection',
  'toggleSelection',
  'setSelectionMany',
  'setAssetSelection',
  'setAssetSelectionOne',
  'setFolderSelection',
]);

async function refreshSelectionAfterSuccess(kind: string, result: DispatchResult): Promise<DispatchResult> {
  if (!result.ok || !SELECTION_OPERATIONS.has(kind)) return result;
  try {
    await refreshViewportRuntimeSelectionSnapshot();
  } catch {
    // The operation already succeeded at the authority. A missing disposable
    // projection must fail later reads closed, not rewrite that fact as failure.
  }
  return result;
}

/**
 * Dispatch a UI operation to the active authority.
 *
 * This seam is for projection clients. Runtime-local code already owns a Gateway
 * and calls it directly. A disconnected client fails closed instead of mutating
 * the shell singleton, which must never become a shadow authoring authority.
 */
export async function dispatchActiveEditorOperation(
  operation: EditorOp,
  origin: CommandOrigin = 'human',
): Promise<DispatchResult> {
  if (getViewportRuntimeClientSnapshot().status !== 'ready') {
    return {
      ok: false,
      error: {
        code: 'operation-failed',
        hint: 'Viewport Runtime is disconnected; reconnect before retrying the operation.',
      },
    };
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
      return refreshSelectionAfterSuccess(kind, result as DispatchResult);
    }
    return refreshSelectionAfterSuccess(kind, { ok: true });
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
