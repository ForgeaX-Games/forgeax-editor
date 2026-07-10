// io/scene-asset-collect.ts — Gateway-owned SceneAsset collection read seam.
//
// The engine collector must run against the SAME module graph, AssetRegistry, and
// live World that own the source entity. Exposing this seam prevents callers from
// importing engine dist files through eval (which can produce incompatible component
// tokens) just to manufacture an instantiateSceneAsset payload.

import { rootsToSceneAsset, Name } from '@forgeax/engine-runtime';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { SceneAsset } from '@forgeax/engine-types';
import type { CommandError } from '../types';

export type CollectSceneAssetResult =
  | { ok: true; asset: SceneAsset }
  | { ok: false; error: CommandError };

/**
 * Collect one live entity subtree into a time-safe SceneAsset POD.
 *
 * This is intentionally a read-only seam: the returned asset represents shared
 * resources by GUID and can subsequently be passed to instantiateSceneAsset, but
 * collection itself never enters the ledger or mutates the world.
 */
export function collectSceneAsset(
  registry: AssetRegistry | undefined,
  world: World | undefined,
  entity: EntityHandle,
): CollectSceneAssetResult {
  if (world === undefined) {
    return {
      ok: false,
      error: {
        code: 'WORLD_UNAVAILABLE',
        hint: 'the editor world is not ready; wait for scene boot before collecting an entity',
      },
    };
  }
  if (registry === undefined) {
    return {
      ok: false,
      error: {
        code: 'NO_REGISTRY',
        hint: 'the active document has no AssetRegistry; scene-asset collection is unavailable before editor boot',
      },
    };
  }
  if (!world.get(entity, Name).ok) {
    return {
      ok: false,
      error: {
        code: 'NO_SUCH_ENTITY',
        hint: `entity ${entity} is not live in the active world; re-query before collecting`,
      },
    };
  }

  const collected = rootsToSceneAsset(registry, world, [entity]);
  if (!collected.ok) {
    return {
      ok: false,
      error: {
        code: 'SCENE_COLLECT_FAILED',
        hint:
          `scene-asset collection failed for entity ${entity}: ${String(collected.error)}. ` +
          'Ensure every referenced asset is catalogued before retrying.',
      },
    };
  }
  return { ok: true, asset: collected.value };
}
