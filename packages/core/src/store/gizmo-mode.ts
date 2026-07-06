// store/gizmo-mode — the viewport transform-gizmo mode (translate/rotate/scale).
//
// State: `gizmoMode` + its listener set. Consumers: the toolbar (setGizmoMode)
// and the viewport gizmo (useGizmoMode / onGizmoModeChange) — a shared toggle.
//
// Anchors:
//   plan-strategy §2 D-2: cluster 3 (store.ts:123-138)
//   research F-2: useSyncExternalStore getter+hook kept in one file
//   requirements AC-09: pure structural migration.
import { useSyncExternalStore } from 'react';

// ── gizmo mode (translate / rotate / scale) — shared by the toolbar + viewport ─
export type GizmoMode = 'translate' | 'rotate' | 'scale';
let gizmoMode: GizmoMode = 'translate';
const gizmoListeners = new Set<() => void>();
export function getGizmoMode(): GizmoMode { return gizmoMode; }
export function setGizmoMode(m: GizmoMode): void {
  if (m === gizmoMode) return;
  gizmoMode = m;
  for (const fn of gizmoListeners) fn();
}
export function onGizmoModeChange(fn: () => void): () => void {
  gizmoListeners.add(fn);
  return () => gizmoListeners.delete(fn);
}
export function useGizmoMode(): GizmoMode {
  return useSyncExternalStore(onGizmoModeChange, getGizmoMode, getGizmoMode);
}
