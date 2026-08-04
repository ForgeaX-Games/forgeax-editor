import { useMemo } from 'react';
import type { AssetWorkspaceSnapshot } from '@forgeax/editor-core';

/**
 * Asset dependency graph (C2) — derived in-memory from the producer-owned
 * relations projected into the workspace snapshot. Older rows use their
 * `refs` compatibility projection in the core read model. Nothing is
 * persisted; the graph is a pure projection of the current catalog.
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

/**
 * Compatibility projection from the workspace relations. The Content Browser
 * no longer constructs graph facts from catalog rows.
 */
export function buildAssetGraph(snapshot: AssetWorkspaceSnapshot): AssetGraph {
  const dependencies = new Map<string, string[]>();
  const referencers = new Map<string, string[]>();

  for (const subject of snapshot.subjects) dependencies.set(subject.id, []);
  for (const relation of snapshot.relations) {
    if (relation.kind !== 'depends-on' || relation.from === relation.to) continue;
    const deps = dependencies.get(relation.from) ?? [];
    if (!deps.includes(relation.to)) dependencies.set(relation.from, [...deps, relation.to]);
    const refs = referencers.get(relation.to) ?? [];
    if (!refs.includes(relation.from)) referencers.set(relation.to, [...refs, relation.from]);
  }
  return { dependencies, referencers };
}

/** React hook wrapper — memoises the workspace projection. */
export function useAssetGraph(snapshot: AssetWorkspaceSnapshot): AssetGraph {
  return useMemo(() => buildAssetGraph(snapshot), [snapshot]);
}
