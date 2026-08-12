// assets/material-instance-loader — teach the engine AssetRegistry how to load
// the editor-owned `material-instance` kind.
//
// WHY THIS EXISTS
//   `material-instance` is an EDITOR kind: it appears nowhere in the engine's
//   Asset union and `wireDefaultLoaders` never registers it. On the Pack v2
//   prod path `loadByGuid` dispatches through `loaders.loadPack(kind)`, so an
//   unregistered kind fails outright with `no loader registered for
//   material-instance` — and every downstream contract that depends on a
//   successful load silently breaks:
//
//     1. The post-write catalog barrier's LOAD phase (assets/authored-asset-
//        barrier) retries loadByGuid until its deadline, so createMaterialInstance
//        stalls for the full 5 s and then reports a catalog-visibility failure —
//        the "created but the asset never shows up" report.
//     2. ensureAssetCataloged / ensureMaterialChainCataloged can never populate
//        registry.assetCatalog for an MI, so resolveOverrides sees no parent
//        chain: blank inspector fields and an unshaded preview mesh.
//
//   The engine already supports exactly this via its host-custom-kind seam
//   (LoaderRegistry.register, proven by runtime's host-custom-kind-contract
//   test): the payload is editor-owned POD, so the loader is an identity
//   projection with a shape guard. The parent/physMaterial GUIDs ride on
//   refs[], which means the registry's generic ref recursion loads the whole
//   parent chain as a side effect of loading the MI.
//
// Anchors: .forgeax-harness/docs/2026-08-05-material-instance-editor-tech-plan.md §A3,
//   architecture-principles #1 (SSOT) — one registration point, called by the
//   host that owns the registry.

import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  MATERIAL_INSTANCE_KIND,
  isMaterialInstancePayload,
  type MaterialInstancePayload,
} from './material-instance-schema';

/** Identity loader: the MI payload is editor POD the engine only has to carry.
 *  Returning `undefined` marks a parse rejection, which the registry surfaces
 *  as a structured `asset-parse-failed` instead of cataloging a malformed
 *  envelope the resolve path would then read as a valid chain link. */
export function materialInstanceLoader(): {
  readonly kind: string;
  load(payload: Record<string, unknown>): MaterialInstancePayload | undefined;
} {
  return {
    kind: MATERIAL_INSTANCE_KIND,
    load(payload: Record<string, unknown>): MaterialInstancePayload | undefined {
      return isMaterialInstancePayload(payload) ? payload : undefined;
    },
  };
}

/** Register the MI loader on a live registry. Idempotent (LoaderRegistry.register
 *  is last-write-wins), so hot reload and repeated host boots are safe. */
export function registerMaterialInstanceLoader(registry: AssetRegistry | undefined): void {
  registry?.loaders?.register(materialInstanceLoader() as never);
}
