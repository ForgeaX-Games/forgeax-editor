// gizmo-pivot — multi-selection gizmo anchor mode (gizmo-ue-parity plan §4.1).
//
// UE parity: with multiple entities selected, the transform gizmo sits at the
// average of the selected pivots by default ('center'); the user can switch it
// to follow the last-selected entity ('lastSelected'). Session-domain state
// (view chrome, not authored data): the applier registers into sessionAppliers
// exactly like gizmo-space.ts, so humans (toolbar) and AI dispatch the SAME
// `setGizmoPivot` op — no second AI-only path (north-star single door).

import { useSyncExternalStore } from 'react';
import type { EditorOp } from '../types';
import { sessionAppliers } from '../io/appliers';

export type GizmoPivot = 'center' | 'lastSelected';
let gizmoPivot: GizmoPivot = 'center';
const pivotListeners = new Set<() => void>();
export function getGizmoPivot(): GizmoPivot { return gizmoPivot; }

function applySetGizmoPivot(op: EditorOp): { ok: true } {
  const p = (op as unknown as { pivot: GizmoPivot }).pivot;
  if (p !== gizmoPivot) {
    gizmoPivot = p;
    for (const fn of pivotListeners) fn();
  }
  return { ok: true };
}
sessionAppliers.set('setGizmoPivot', applySetGizmoPivot);

export function onGizmoPivotChange(fn: () => void): () => void {
  pivotListeners.add(fn);
  return () => pivotListeners.delete(fn);
}
export function useGizmoPivot(): GizmoPivot {
  return useSyncExternalStore(onGizmoPivotChange, getGizmoPivot, getGizmoPivot);
}
