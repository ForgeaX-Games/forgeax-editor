// store/gizmo-mode — the viewport transform-gizmo mode (translate/rotate/scale).
//
// State: `gizmoMode` + its listener set. Consumers: the toolbar (setGizmoMode)
// and the viewport gizmo (useGizmoMode / onGizmoModeChange) — a shared toggle.
//
// Anchors:
//   plan-strategy §2 D-2: cluster 3 (store.ts:123-138)
//   plan-strategy §2 D-1: setGizmoMode is a SESSION-domain op — body is the
//     applier, registered into sessionAppliers; setter dispatches (M2 m2-w6).
//   research F-2: useSyncExternalStore getter+hook kept in one file
//   requirements AC-02/AC-09: session op → ledger only, AI-dispatchable.
import { useSyncExternalStore } from 'react';
import type { EditorOp } from '../types';
import { gateway } from './gateway';
import { sessionAppliers } from '../io/appliers';

// ── gizmo mode (translate / rotate / scale) — shared by the toolbar + viewport ─
export type GizmoMode = 'translate' | 'rotate' | 'scale';
let gizmoMode: GizmoMode = 'translate';
const gizmoListeners = new Set<() => void>();
export function getGizmoMode(): GizmoMode { return gizmoMode; }

// Session applier (M2 D-1): the mutation body, registered into the session table.
function applySetGizmoMode(op: EditorOp): { ok: true } {
  const m = (op as { mode: GizmoMode }).mode;
  if (m !== gizmoMode) {
    gizmoMode = m;
    for (const fn of gizmoListeners) fn();
  }
  return { ok: true };
}
sessionAppliers.set('setGizmoMode', applySetGizmoMode);

export function setGizmoMode(m: GizmoMode): void {
  gateway.dispatch({ kind: 'setGizmoMode', mode: m });
}
export function onGizmoModeChange(fn: () => void): () => void {
  gizmoListeners.add(fn);
  return () => gizmoListeners.delete(fn);
}
export function useGizmoMode(): GizmoMode {
  return useSyncExternalStore(onGizmoModeChange, getGizmoMode, getGizmoMode);
}
