/**
 * TEMPORARY (release / Shell+Transport only) — import OperationRun progress via poll.
 *
 * ## Canonical design (editor `main`, unchanged)
 *
 * Content Browser runs beside the live Gateway and uses **push** updates:
 *
 *   gateway.dispatch({ kind: 'importAsset', requestId, ... })
 *   gateway.subscribeOperationRun(requestId, onRunUpdate)
 *   await gateway.waitOperationRun(requestId)
 *
 * See `packages/core/src/io/catalog.ts` → `importAsset.operationRun.read.subscribe`.
 *
 * ## Why this file exists (release20260901+ / Studio pin)
 *
 * After #585, the Shell dispatches through Transport (`dispatchActiveEditorOperation`)
 * and cannot call `gateway.subscribeOperationRun`. Transport exposes `run.get` /
 * `run.wait` but **not** `run.subscribe` yet. This module polls `run.get` every
 * 100ms as a **stopgap** until scheme B lands (Transport `run.subscribe`).
 *
 * **Do not merge this poll path into `main` without replacing it by subscribe.**
 * **Delete this file** when scheme B is implemented (checklist in
 * `puckyu-doc/knowledge/editor-import-progress-bar-design.md` §8).
 *
 * SSOT for the decision / migration plan: that knowledge doc.
 */

import {
  dispatchActiveEditorOperation,
  getViewportRuntimeClientSnapshot,
  getViewportRuntimeOperationRun,
  waitViewportRuntimeOperationRun,
  type EditorOp,
  type OperationRun,
} from '@forgeax/editor-core';

/** Poll interval — trade latency vs Transport load; not used on main. */
export const IMPORT_RUN_TRANSPORT_POLL_MS = 100;

const BENIGN_VIEWPORT_RUNTIME_TRANSPORT_ERRORS = new Set([
  'viewport-runtime-disconnected',
  'viewport-runtime-stale-generation',
]);

/** Transient viewport rebind during heavy import — poll/wait may retry quietly. */
export function isBenignViewportRuntimeTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return BENIGN_VIEWPORT_RUNTIME_TRANSPORT_ERRORS.has(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitViewportRuntimeOperationRunResilient(
  requestId: string,
): Promise<Awaited<ReturnType<typeof waitViewportRuntimeOperationRun>>> {
  while (true) {
    try {
      return await waitViewportRuntimeOperationRun(requestId);
    } catch (error) {
      if (!isBenignViewportRuntimeTransportError(error)) throw error;
      await sleep(IMPORT_RUN_TRANSPORT_POLL_MS);
    }
  }
}

/** UI-only monotonic cache keyed off poll snapshots (release poll workaround). */
export interface ImportRunProgressProjection {
  currentRun?: OperationRun;
  liveFraction?: number;
  liveStage?: string;
}

export function mergeMonotonicImportRun(
  previous: OperationRun | undefined,
  next: OperationRun,
): OperationRun {
  if (previous === undefined) return next;
  if (next.progress.fraction >= previous.progress.fraction) return next;
  return {
    ...next,
    progress: {
      ...next.progress,
      fraction: previous.progress.fraction,
      stage: previous.progress.stage,
    },
  };
}

export function applyImportRunProgressProjection(
  projection: ImportRunProgressProjection,
  run: OperationRun,
): void {
  const merged = mergeMonotonicImportRun(projection.currentRun, run);
  projection.currentRun = merged;
  projection.liveFraction = merged.progress.fraction;
  projection.liveStage = merged.progress.stage;
}

/** Placeholder accepted run so the overlay can render before the first poll tick. */
export function createAcceptedImportRunPlaceholder(requestId: string): OperationRun {
  return {
    schemaVersion: 'operation-run/v1',
    runId: `pending-${requestId}`,
    requestId,
    operationId: 'importAsset',
    status: 'accepted',
    actor: { id: 'editor-panel', kind: 'human' },
    sessionId: 'editor-panel',
    scope: 'editor',
    traceId: requestId,
    attempt: 1,
    cancellable: true,
    retryable: true,
    progress: { stage: 'accepted', fraction: 0 },
    recoveryActions: [],
    effectResults: {},
    acceptedAt: Date.now(),
    sequence: 1,
  };
}

/**
 * Poll Transport `run.get` until `run.wait` returns terminal — **release-only**.
 *
 * Must start **in parallel** with `dispatchActiveEditorOperation` (same requestId);
 * a blocking dispatch would otherwise prevent mid-flight UI updates.
 */
export async function waitForImportRunViaTransportPoll(
  requestId: string,
  onRunUpdate: (run: OperationRun) => void,
): Promise<OperationRun> {
  let latestRun: OperationRun | undefined;
  const publishLatest = (): void => {
    if (latestRun === undefined) return;
    onRunUpdate(latestRun);
  };

  const poll = setInterval(() => {
    if (getViewportRuntimeClientSnapshot().status !== 'ready') return;
    void getViewportRuntimeOperationRun(requestId)
      .then((response) => {
        if (response.error !== undefined || response.result === undefined) return;
        latestRun = response.result as OperationRun;
        publishLatest();
      })
      .catch(() => {
        // Viewport may rebind while import blocks the worker; wait() owns terminal truth.
      });
  }, IMPORT_RUN_TRANSPORT_POLL_MS);

  try {
    const terminalResponse = await waitViewportRuntimeOperationRunResilient(requestId);
    if (terminalResponse.error !== undefined) {
      throw new Error(terminalResponse.error.hint ?? terminalResponse.error.code);
    }
    latestRun = terminalResponse.result as OperationRun;
    publishLatest();
    return latestRun;
  } finally {
    clearInterval(poll);
  }
}

type ImportAssetOp = Extract<EditorOp, { kind: 'importAsset' }>;

/** Dispatch importAsset while polling progress — release Transport workaround. */
export async function dispatchImportAssetWithTransportPoll(
  operation: ImportAssetOp,
  onRunUpdate: (run: OperationRun) => void,
): Promise<{ readonly dispatch: Awaited<ReturnType<typeof dispatchActiveEditorOperation>>; readonly terminal: OperationRun }> {
  const requestId = operation.requestId;
  const [dispatch, terminal] = await Promise.all([
    dispatchActiveEditorOperation(operation, 'human'),
    waitForImportRunViaTransportPoll(requestId, onRunUpdate),
  ]);
  return { dispatch, terminal };
}
