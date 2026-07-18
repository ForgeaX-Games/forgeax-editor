// store/mesh-stats — derived geometry-free stats for the selected mesh
// (MAIN window → Mesh panel cross-panel channel).
//
// State: `selectedMeshStats` + its listener set. Only the MAIN window holds the
// engine asset registry, so it loads the selected mesh via loadByGuid, derives
// geometry-free stats, and publishes them here (publishMeshStats); the Mesh
// panel (a registry-less iframe) renders them via useMeshStats. Mirrors the
// asset-selection channel.
//
// Anchors:
//   plan-strategy §2 D-2: cluster 13 (store.ts:1316-1338)
//   research F-2: useSyncExternalStore getter+hook kept in one file
//   requirements AC-09: pure structural migration.
//   Design: docs/design/editor-mesh-panel.md §4.3.
import { useSyncExternalStore } from 'react';
import type { MeshStatsWire } from '../io/cross-panel-types';

// ── Mesh stats (cross-panel: MAIN window loads mesh → Mesh panel) ─────────────
// meta.json mesh sub-assets carry NO geometry in their Content Browser payload
// (see editor-core/assets.ts loadMetaAssets). Only the MAIN window holds the
// engine asset registry, so it loads the selected mesh via loadByGuid, derives
// geometry-free stats, and publishes them here; the Mesh panel (a registry-less
// iframe) renders them. Mirrors the asset-selection channel above.
// Design: docs/design/editor-mesh-panel.md §4.3.

export type MeshStats = MeshStatsWire;

let selectedMeshStats: MeshStats | null = null;
const meshStatsListeners = new Set<() => void>();
function emitMeshStats(): void { for (const fn of meshStatsListeners) fn(); }

/** MAIN window: publish derived stats for the currently-selected mesh (broadcasts
 *  to popouts/panels). Pass null to clear. */
export function publishMeshStats(stats: MeshStats | null): void {
  selectedMeshStats = stats;
  emitMeshStats();

}
export function getMeshStats(): MeshStats | null { return selectedMeshStats; }
function subscribeMeshStats(fn: () => void): () => void {
  meshStatsListeners.add(fn);
  return () => meshStatsListeners.delete(fn);
}
/** Panel hook: the latest published mesh stats (check `.guid` against the
 *  selected asset before rendering — a stale entry may linger during a switch). */
export function useMeshStats(): MeshStats | null {
  return useSyncExternalStore(subscribeMeshStats, getMeshStats, getMeshStats);
}
