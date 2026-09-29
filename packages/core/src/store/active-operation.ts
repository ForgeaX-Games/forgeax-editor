// Current-authority UI operation seam.
//
// Dispatch routing pairs with panel reads — see `io/editor-panel-authority.ts`.
// Callers use dispatchActiveEditorOperation; they must not choose gateway vs
// run.dispatch independently of that snapshot.

import type { CommandError, EditorOp } from '../types';
import type { DispatchResult } from '../io/gateway';
import type { CommandOrigin } from '../io/gateway-history';
import {
  canDispatchPanelDocumentOperations,
  getEditorPanelAuthoritySnapshot,
  usesHostGatewayForPanelDispatch,
} from '../io/editor-panel-authority';
import { traceHierarchyVisibility } from '../io/hierarchy-visibility-trace';
import { broadcastAssetsChanged } from './assets-changed';
import { gateway } from './gateway';
import { resolveGamePath } from '../util/path-resolver';
import { refreshAuthoritativeSceneReadModel } from '../io/scene-read-model-client';
import {
  dispatchViewportRuntimeOperation,
  getViewportRuntimeClientSnapshot,
  refreshViewportRuntimeHierarchySnapshot,
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

const SCENE_MANIFEST_OPERATIONS = new Set([
  'switchSceneFile',
  'createSceneFile',
  'deleteScene',
  'setDefaultScene',
]);

const HIERARCHY_STRUCTURE_REFRESH_KINDS = new Set([
  'setVisibility',
  'hierarchyGesture',
]);

async function refreshSelectionAfterSuccess(kind: string, result: DispatchResult): Promise<DispatchResult> {
  if (!result.ok) return result;
  if (SELECTION_OPERATIONS.has(kind)) {
    try {
      await refreshViewportRuntimeSelectionSnapshot();
    } catch {
      // The operation already succeeded at the authority. A missing disposable
      // projection must fail later reads closed, not rewrite that fact as failure.
    }
  }
  if (SCENE_MANIFEST_OPERATIONS.has(kind)) {
    await refreshAuthoritativeSceneReadModel();
  }
  return result;
}

async function refreshHierarchyStructureAfterSuccess(kind: string, result: DispatchResult): Promise<DispatchResult> {
  if (!result.ok || !HIERARCHY_STRUCTURE_REFRESH_KINDS.has(kind)) return result;
  if (getViewportRuntimeClientSnapshot().status !== 'ready') return result;
  traceHierarchyVisibility('carrier.refresh.start', { kind });
  try {
    const snapshot = await refreshViewportRuntimeHierarchySnapshot();
    traceHierarchyVisibility('carrier.refresh.done', {
      kind,
      rowCount: snapshot.structure.rows.length,
      selectionCount: snapshot.selectionIds.length,
    });
  } catch (error) {
    traceHierarchyVisibility('carrier.refresh.failed', {
      kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return result;
}

async function refreshHostProjectionsAfterSuccess(kind: string, result: DispatchResult): Promise<DispatchResult> {
  return refreshHierarchyStructureAfterSuccess(
    kind,
    await refreshSelectionAfterSuccess(kind, result),
  );
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
  const authority = getEditorPanelAuthoritySnapshot();
  const { kind } = operation;

  const dispatchOnLiveGateway = async (): Promise<DispatchResult> => {
    return refreshHostAfterDirectoryOperation(
      operation,
      await refreshHostProjectionsAfterSuccess(kind, gateway.dispatch(operation, origin)),
    );
  };

  if (!canDispatchPanelDocumentOperations(authority)) {
    console.warn(
      '[editor] operation blocked: Viewport Runtime is disconnected',
      operation.kind,
    );
    return {
      ok: false,
      error: transportOperationError(
        operation,
        'Viewport Runtime is disconnected; reconnect before retrying the operation.',
      ),
    };
  }

  if (usesHostGatewayForPanelDispatch(authority)) {
    return dispatchOnLiveGateway();
  }

  const { kind: remoteKind, ...input } = operation;
  try {
    const response = await dispatchViewportRuntimeOperation(remoteKind, input, {
      id: `editor-${origin}`,
      kind: origin,
    });
    if (response.error !== undefined) {
      const failed = { ok: false as const, error: response.error as CommandError };
      return failed;
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
          hint: `Runtime operation "${remoteKind}" ended ${String(run.status)}.`,
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
        await refreshHostProjectionsAfterSuccess(remoteKind, operationResult),
      );
    }
    const succeeded = await refreshHostAfterDirectoryOperation(
      operation,
      await refreshHostProjectionsAfterSuccess(remoteKind, { ok: true }),
    );
    return succeeded;
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
