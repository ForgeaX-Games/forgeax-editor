// Current-authority UI operation seam.
//
// Business UI can live either beside the Runtime or in a disposable shell. It
// must not know which carrier is active, and it must never fall back to a shell
// shadow World. This adapter chooses the one current authority while preserving
// the Gateway operation payload and structured result.

import type { CommandError, EditorOp } from '../types';
import type { DispatchResult } from '../io/gateway';
import type { CommandOrigin } from '../io/gateway-history';
import { getActiveRuntimeUiGraph } from '../io/runtime-ui-diagnostics';
import { broadcastAssetsChanged } from './assets-changed';
import { gateway } from './gateway';
import { resolveGamePath } from '../util/path-resolver';
import {
  dispatchViewportRuntimeOperation,
  getViewportRuntimeClientSnapshot,
  refreshViewportRuntimeSelectionSnapshot,
  waitViewportRuntimeOperationRun,
} from '../io/viewport-runtime-client';

export type ActiveOperationResult =
  | { readonly ok: true; readonly result?: unknown }
  | { readonly ok: false; readonly error: CommandError };

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

function treeContainsPath(value: unknown, targetPath: string): boolean {
  if (Array.isArray(value)) return value.some((item) => treeContainsPath(item, targetPath));
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.path === targetPath) return true;
  return Object.values(record).some((item) => treeContainsPath(item, targetPath));
}

async function waitForDirectoryWrite(
  parentPath: string,
  name: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  const relativeTarget = `${parentPath || 'assets'}/${name}`;
  const targetPath = resolveGamePath(relativeTarget);
  const rootPath = resolveGamePath(parentPath || 'assets');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`/api/files/tree?root=${encodeURIComponent(rootPath)}&optional=1`, {
        cache: 'no-store',
      });
      if (response.ok) {
        const body: unknown = await response.json();
        if (treeContainsPath(body, targetPath)) return true;
      }
    } catch {
      // The Runtime write may still be completing or the backend may be restarting.
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
  }
  return false;
}

async function refreshHostAfterDirectoryOperation(
  operation: EditorOp,
  result: DispatchResult,
): Promise<DispatchResult> {
  if (!result.ok || operation.kind !== 'createDirectory') return result;
  const directoryOperation = operation as Extract<EditorOp, { kind: 'createDirectory' }>;
  const written = await waitForDirectoryWrite(directoryOperation.parentPath, directoryOperation.name);
  if (written) broadcastAssetsChanged('directory-only', 'local-op');
  return result;
}

/**
 * Dispatch a UI operation to the active authority.
 *
 * This seam is for projection clients. Runtime-local code already owns a Gateway
 * and calls it directly. A disconnected iframe-shell client fails closed instead
 * of mutating a shadow World. Same-window Studio still hosts the live
 * EditGateway (Hierarchy already reads it), so Play/Stop must use that Gateway
 * when the panel Runtime client has not bound — or a sibling boot unbind left
 * the client cache disconnected.
 */
export async function dispatchActiveEditorOperation(
  operation: EditorOp,
  origin: CommandOrigin = 'human',
): Promise<DispatchResult> {
  if (getViewportRuntimeClientSnapshot().status !== 'ready') {
    if (getActiveRuntimeUiGraph() !== null) {
      const { kind } = operation;
      return refreshSelectionAfterSuccess(kind, gateway.dispatch(operation, origin));
    }
    console.warn(
      '[editor] operation blocked: Viewport Runtime is disconnected',
      operation.kind,
    );
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
          retryable: true,
          recoveryActions: ['operation.retry'],
        }) as CommandError,
      };
    }
    const result = run?.result;
    if (
      result !== null
      && typeof result === 'object'
      && typeof (result as { ok?: unknown }).ok === 'boolean'
    ) {
      const operationResult = result as DispatchResult;
      return refreshHostAfterDirectoryOperation(
        operation,
        await refreshSelectionAfterSuccess(kind, operationResult),
      );
    }
    return refreshHostAfterDirectoryOperation(
      operation,
      await refreshSelectionAfterSuccess(kind, { ok: true }),
    );
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

function transportOperationError(
  operation: EditorOp,
  hint: string,
): CommandError {
  const requestId = 'requestId' in operation && typeof operation.requestId === 'string'
    ? operation.requestId
    : undefined;
  return {
    code: 'operation-failed',
    hint,
    ...(requestId === undefined ? {} : { requestId }),
    retryable: true,
    recoveryActions: ['transport.reconnect'],
  };
}

/**
 * Dispatch a request-correlated Runtime operation and consume its terminal
 * result without throwing. The Runtime OperationRun remains the only journal;
 * this helper merely projects that terminal fact to a detached UI caller.
 */
export async function dispatchAndWaitActiveEditorOperation(
  operation: EditorOp,
  origin: CommandOrigin = 'human',
): Promise<ActiveOperationResult> {
  const accepted = await dispatchActiveEditorOperation(operation, origin);
  if (!accepted.ok) return accepted;
  const requestId = 'requestId' in operation && typeof operation.requestId === 'string'
    ? operation.requestId
    : undefined;
  if (requestId === undefined) return accepted;
  try {
    const response = await waitViewportRuntimeOperationRun(requestId);
    if (response.error !== undefined) return { ok: false, error: response.error as CommandError };
    const run = response.result as {
      readonly status?: unknown;
      readonly result?: unknown;
      readonly error?: CommandError;
    } | undefined;
    if (run?.status === 'failed' || run?.status === 'cancelled') {
      return {
        ok: false,
        error: run.error ?? transportOperationError(
          operation,
          `Runtime operation "${operation.kind}" ended ${String(run.status)} without a structured error.`,
        ),
      };
    }
    if (run?.status === 'succeeded') {
      const result = run.result;
      if (result !== null && typeof result === 'object' && typeof (result as { ok?: unknown }).ok === 'boolean') {
        const projected = result as { readonly ok: boolean; readonly error?: CommandError; readonly result?: unknown };
        return projected.ok
          ? { ok: true, result: 'result' in projected ? projected.result : result }
          : { ok: false, error: projected.error ?? transportOperationError(operation, `Runtime operation "${operation.kind}" failed without a structured error.`) };
      }
      return { ok: true, result };
    }
    return { ok: false, error: transportOperationError(operation, `Runtime returned no terminal result for "${operation.kind}".`) };
  } catch (cause) {
    return {
      ok: false,
      error: transportOperationError(
        operation,
        cause instanceof Error ? cause.message : String(cause),
      ),
    };
  }
}
