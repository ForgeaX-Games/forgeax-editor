import { useSyncExternalStore } from 'react';
import type { EditorOp } from '../types';
import { registerApplier } from '../io/appliers';

export type GizmoSpace = 'world' | 'local';
/** UE level-viewport default: world-aligned manipulation axes unless toggled local. */
let gizmoSpace: GizmoSpace = 'world';
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
registerApplier('session', 'setGizmoSpace', applySetGizmoSpace);

export function onGizmoSpaceChange(fn: () => void): () => void {
  spaceListeners.add(fn);
  return () => spaceListeners.delete(fn);
}
export function useGizmoSpace(): GizmoSpace {
  return useSyncExternalStore(onGizmoSpaceChange, getGizmoSpace, getGizmoSpace);
}
