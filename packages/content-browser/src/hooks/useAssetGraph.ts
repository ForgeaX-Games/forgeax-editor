import { useMemo } from 'react';

/**
 * Asset dependency graph (C2) — derived in-memory from the forward `refs`
 * edges the engine surfaces via `listCatalog().refs` (engine
 * refs-through-listCatalog). Nothing is persisted; the graph is a pure
 * projection of the current catalog, rebuilt whenever the asset list changes.
 *
 * Per the content-browser data-ownership ruling (L2): keys and values are all
 * engine GUIDs (36-char UUID). Folders (which have no GUID) never enter the
 * graph.
 *
 * - `dependencies.get(guid)` → the GUIDs `guid` depends on (its own `refs`,
 *   forward edges).
 * - `referencers.get(guid)` → the GUIDs that depend on `guid` (reverse edges).
 *   This reverse index is the editor-owned half the engine does not provide;
 *   it powers the Referencers viewer and the delete guard (C3).
 */
export interface AssetGraph {
  dependencies: Map<string, string[]>;
  referencers: Map<string, string[]>;
}

/** Minimal shape a graph node needs — any object carrying a guid + refs. */
export interface AssetGraphNode {
  guid: string;
  refs: readonly string[];
}

/**
 * Build the forward (dependencies) + reverse (referencers) dependency graph
 * from a flat asset list. Pure and side-effect free so it can be unit tested
 * and memoised. Self-references and duplicate edges are de-duplicated; a
 * self-reference never lists a node as its own referencer.
 */
export function buildAssetGraph(assets: readonly AssetGraphNode[]): AssetGraph {
  const dependencies = new Map<string, string[]>();
  const referencers = new Map<string, string[]>();

  for (const asset of assets) {
    // Forward edges: de-dup + drop self-reference for a clean dependency set.
    const deps: string[] = [];
    for (const dep of asset.refs) {
      if (dep === asset.guid || deps.includes(dep)) continue;
      deps.push(dep);
    }
    dependencies.set(asset.guid, deps);

    // Reverse edges: each dependency gains `asset.guid` as a referencer.
    for (const dep of deps) {
      const arr = referencers.get(dep);
      if (arr === undefined) {
        referencers.set(dep, [asset.guid]);
      } else if (!arr.includes(asset.guid)) {
        arr.push(asset.guid);
      }
    }
  }

  return { dependencies, referencers };
}

/** React hook wrapper — memoises {@link buildAssetGraph} over the asset list. */
export function useAssetGraph(assets: readonly AssetGraphNode[]): AssetGraph {
  return useMemo(() => buildAssetGraph(assets), [assets]);
}
