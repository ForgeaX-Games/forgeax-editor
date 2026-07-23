import { useSyncExternalStore } from 'react';
import type { EditorOp } from '../types';
import { sessionAppliers } from '../io/appliers';

export type GizmoSpace = 'world' | 'local';
let gizmoSpace: GizmoSpace = 'local';
const spaceListeners = new Set<() => void>();
export function getGizmoSpace(): GizmoSpace { return gizmoSpace; }

function applySetGizmoSpace(op: EditorOp): { ok: true } {
  const s = (op as unknown as { space: GizmoSpace }).space;
  if (s !== gizmoSpace) {
    gizmoSpace = s;
    for (const fn of spaceListeners) fn();
  }
  return { ok: true };
}
sessionAppliers.set('setGizmoSpace', applySetGizmoSpace);

export function onGizmoSpaceChange(fn: () => void): () => void {
  spaceListeners.add(fn);
  return () => spaceListeners.delete(fn);
}
export function useGizmoSpace(): GizmoSpace {
  return useSyncExternalStore(onGizmoSpaceChange, getGizmoSpace, getGizmoSpace);
}
