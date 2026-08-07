// assets/material-chain-catalog — the ONE way an editor surface reads a
// material / material-instance parent chain out of the live AssetRegistry.
//
// WHY THIS EXISTS
//   `resolveOverrides` needs a synchronous MaterialCatalogLookup, but the only
//   synchronous catalog in the registry is `assetCatalog`, which ONLY
//   `loadByGuid` populates — `refreshCatalog` fetches pack-index ROWS, never
//   payloads. A Material Instance whose parent has not been loaded this session
//   (the normal case: the parent is an authored material in Materials.pack.json
//   or an inline material inside scene.pack.json that the current scene never
//   referenced) therefore resolves to an EMPTY value map, which the MI editor
//   renders as blank fields and the preview renders as an unshaded mesh.
//
//   So the lookup is only half the contract: the surface must first WARM the
//   chain (async loadByGuid per ancestor), then read it synchronously. Both
//   halves live here so the properties panel and the 3D preview cannot drift.

import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { ensureAssetCataloged } from './ensure-asset-cataloged';
import {
  MATERIAL_INSTANCE_KIND,
  isGuid,
  isMaterialInstancePayload,
  type MaterialInstancePayload,
} from './material-instance-schema';
import type { MaterialCatalogLookup } from './material-instance-resolve';

/** Depth bound for a malformed on-disk chain the cycle guard cannot see
 *  (the visited set already stops true cycles; this stops pathological depth). */
const MAX_CHAIN_DEPTH = 32;

/** Synchronous parent-chain lookup over the live registry envelopes. */
export function materialCatalogLookup(registry: AssetRegistry | undefined): MaterialCatalogLookup {
  return (guid: string) => {
    const envelope = registry?.assetCatalog?.get(guid.toLowerCase());
    if (envelope === undefined) return undefined;
    return {
      guid: envelope.guid,
      kind: envelope.kind,
      payload: envelope.payload as unknown as Record<string, unknown>,
    };
  };
}

/**
 * Load every ancestor of `start` into `registry.assetCatalog` so a subsequent
 * `materialCatalogLookup(registry)` resolves the whole chain synchronously.
 *
 * `start` is an MI payload (walk begins at its parent) or a bare GUID (walk
 * begins at that asset). Returns false when an ancestor could not be loaded —
 * callers keep whatever partial resolve they have rather than blanking the UI.
 */
export async function ensureMaterialChainCataloged(
  registry: AssetRegistry | undefined,
  start: MaterialInstancePayload | string,
): Promise<boolean> {
  if (registry === undefined) return false;
  const lookup = materialCatalogLookup(registry);
  const visited = new Set<string>();
  let current: string | undefined = typeof start === 'string' ? start : start.parent;

  for (let depth = 0; current !== undefined && depth < MAX_CHAIN_DEPTH; depth += 1) {
    const key = current.toLowerCase();
    if (visited.has(key)) return true;
    visited.add(key);
    if (!isGuid(current)) return false;
    if (!(await ensureAssetCataloged(registry, current))) return false;
    const entry = lookup(current);
    if (entry === undefined) return false;
    if (entry.kind === MATERIAL_INSTANCE_KIND && isMaterialInstancePayload(entry.payload)) {
      current = entry.payload.parent;
      continue;
    }
    if (entry.kind === 'material') {
      const parent = entry.payload.parent;
      current = typeof parent === 'string' && parent.length > 0 ? parent : undefined;
      continue;
    }
    return true;
  }
  return true;
}
