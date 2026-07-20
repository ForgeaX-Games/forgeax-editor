import type { AssetGraph } from './hooks/useAssetGraph';

/**
 * Delete-guard impact analysis (C3) — before destroying assets we ask the
 * reverse dependency index (C2) "who still points at these?". Assets that are
 * part of the same delete batch don't count (deleting a pair that reference
 * each other is safe), so only *external* referencers raise a warning, mirroring
 * the delete-protection dialogs in UE / Godot.
 */
export interface DeleteImpact {
  /** guid → external referencer guids (referencers NOT in the delete batch). */
  externalReferencers: Map<string, string[]>;
  /** True when at least one target is still referenced from outside the batch. */
  hasExternalReferencers: boolean;
  /** Total distinct external referencer guids across all targets. */
  externalReferencerCount: number;
}

/**
 * Compute which of `targetGuids` are still referenced by assets outside the
 * delete batch. Pure and side-effect free for unit testing.
 */
export function computeDeleteImpact(
  targetGuids: readonly string[],
  graph: AssetGraph,
): DeleteImpact {
  const batch = new Set(targetGuids);
  const externalReferencers = new Map<string, string[]>();
  const distinctExternal = new Set<string>();

  for (const guid of targetGuids) {
    const refs = graph.referencers.get(guid) ?? [];
    const external = refs.filter((r) => !batch.has(r));
    if (external.length > 0) {
      externalReferencers.set(guid, external);
      for (const r of external) distinctExternal.add(r);
    }
  }

  return {
    externalReferencers,
    hasExternalReferencers: externalReferencers.size > 0,
    externalReferencerCount: distinctExternal.size,
  };
}
