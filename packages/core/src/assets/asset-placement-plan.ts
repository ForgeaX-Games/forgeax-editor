// Producer-driven placement planning for Content Browser drag, context-menu,
// and AI/Gateway callers. The plan is pure: it selects an existing Gateway
// operation and builds that operation's exact args without mutating the world.

import {
  authoringCapabilityForAssetKind,
  type AssetAuthoringCapability,
} from '@forgeax/engine-types';
import { buildSpawnEntityFromDragRef, type DragAssetRef } from './drag-asset-spawn';

export type AssetPlacementPlan =
  | {
      readonly operation: 'spawnEntity';
      readonly args: {
        readonly kind: 'spawnEntity';
        readonly name: string;
        readonly components: Record<string, unknown>;
      };
      readonly capability: AssetAuthoringCapability;
    }
  | {
      readonly operation: 'addSceneAssetToScene';
      readonly args: {
        readonly kind: 'addSceneAssetToScene';
        readonly sceneGuid: string;
        readonly name: string;
        readonly requestId: string;
      };
      readonly capability: AssetAuthoringCapability;
    };

export type AssetPlacementPlanError = {
  readonly code: 'placement-unavailable' | 'placement-input-invalid';
  readonly hint: string;
};

export type AssetPlacementPlanResult =
  | { readonly ok: true; readonly plan: AssetPlacementPlan }
  | { readonly ok: false; readonly error: AssetPlacementPlanError };

export interface AssetPlacementPlanOptions {
  /** Required for the request-correlated scene session operation. */
  readonly requestId?: string;
  /** Used by mesh drag to preserve recovered per-submesh material refs. */
  readonly materialGuids?: readonly string[];
  /** Resolved scene sub-asset GUID when the source ref came from a meta file. */
  readonly sceneGuid?: string;
}

function capabilityFor(ref: DragAssetRef): AssetAuthoringCapability {
  return ref.authoring ?? authoringCapabilityForAssetKind(ref.kind ?? '');
}

/**
 * Build one producer-authorized placement command. Consumers may project the
 * returned capability, but they must dispatch the returned args unchanged.
 */
export function planAssetPlacement(
  ref: DragAssetRef,
  options: AssetPlacementPlanOptions = {},
): AssetPlacementPlanResult {
  const capability = capabilityFor(ref);
  if (capability.placement.operation === 'unavailable') {
    return { ok: false, error: { code: 'placement-unavailable', hint: capability.placement.reason.hint } };
  }

  if (capability.placement.operation === 'addSceneAssetToScene') {
    const sceneGuid = options.sceneGuid ?? ref.guid;
    if (typeof sceneGuid !== 'string' || sceneGuid.length === 0) {
      return { ok: false, error: { code: 'placement-input-invalid', hint: 'scene placement requires a non-empty scene sub-asset GUID' } };
    }
    if (typeof options.requestId !== 'string' || options.requestId.length === 0) {
      return { ok: false, error: { code: 'placement-input-invalid', hint: 'scene placement requires a requestId for OperationRun correlation' } };
    }
    return {
      ok: true,
      plan: {
        operation: 'addSceneAssetToScene',
        args: {
          kind: 'addSceneAssetToScene',
          sceneGuid,
          name: ref.name?.trim() || ref.guid.slice(0, 8) || 'Scene',
          requestId: options.requestId,
        },
        capability,
      },
    };
  }

  const spawn = buildSpawnEntityFromDragRef(ref, options.materialGuids ? { materialGuids: [...options.materialGuids] } : undefined);
  if (!spawn) {
    return { ok: false, error: { code: 'placement-unavailable', hint: `producer advertised spawnEntity but no spawn plan exists for asset kind '${ref.kind ?? ''}'` } };
  }
  return {
    ok: true,
    plan: {
      operation: 'spawnEntity',
      args: { kind: 'spawnEntity', name: spawn.name, components: spawn.components },
      capability,
    },
  };
}
