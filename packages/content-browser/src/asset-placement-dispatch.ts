/**
 * Content Browser asset placement through the active Editor Runtime.
 *
 * The Content Browser may be rendered in a shell window while the authoritative
 * EditGateway lives in a viewport carrier iframe. This module deliberately
 * plans plain EditorOp data locally and sends it through the Runtime client;
 * it never mutates the shell gateway or crosses the boundary with a Gateway
 * object.
 */
import {
  broadcastAssetsError,
  dispatchActiveEditorOperation,
  planAssetPlacement,
  waitViewportRuntimeOperationRun,
  type OperationRun,
} from '@forgeax/editor-core';
import type { CBAsset } from './types';

function placementRef(asset: CBAsset) {
  return {
    type: 'asset' as const,
    guid: asset.guid,
    kind: asset.kind,
    name: asset.name,
    path: asset.packPath,
    payload: asset.payload,
    authoring: asset.authoring,
  };
}

function reportPlacementFailure(asset: CBAsset, operation: string, hint: string): void {
  console.warn('[content-browser] asset placement failed', {
    operation,
    guid: asset.guid,
    name: asset.name,
    path: asset.packPath,
    hint,
  });
  broadcastAssetsError({
    op: operation,
    path: asset.packPath,
    hint,
  });
}

/**
 * Place one catalog asset through the current Runtime authority.
 *
 * `planAssetPlacement` remains the producer-owned capability projection. The
 * returned operation is then sent through `dispatchActiveEditorOperation`, so
 * both local UI and remote/iframe UI reach the same active EditGateway.
 */
export async function dispatchAssetPlacement(
  asset: CBAsset,
  catalogAssets: readonly CBAsset[],
): Promise<void> {
  try {
    const requestId = crypto.randomUUID();
    const catalogGuids = catalogAssets.map((candidate) => candidate.guid);
    const plan = planAssetPlacement(placementRef(asset), {
      requestId,
      ...(catalogGuids.length > 0 ? { catalogGuids } : {}),
    });

    if (!plan.ok) {
      reportPlacementFailure(asset, 'placeAsset', plan.error.hint);
      return;
    }

    const accepted = await dispatchActiveEditorOperation(plan.plan.args, 'human');
    if (!accepted.ok) {
      reportPlacementFailure(asset, plan.plan.args.kind, accepted.error.hint);
      return;
    }

    if (plan.plan.operation !== 'addSceneAssetToScene') return;

    const terminalResponse = await waitViewportRuntimeOperationRun(requestId);
    if (terminalResponse.error !== undefined) {
      reportPlacementFailure(asset, plan.plan.args.kind, terminalResponse.error.hint);
      return;
    }

    const terminal = terminalResponse.result as OperationRun | undefined;
    if (terminal?.status === 'succeeded') return;

    reportPlacementFailure(
      asset,
      plan.plan.args.kind,
      terminal?.error?.hint ?? 'Scene placement did not reach a successful terminal state.',
    );
  } catch (cause) {
    reportPlacementFailure(
      asset,
      'placeAsset',
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}
