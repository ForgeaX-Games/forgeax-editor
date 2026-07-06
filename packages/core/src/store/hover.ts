// store/hover — the transient hover-highlight signal ("pointer over a handle
// that refers to entity N").
//
// State: `hoverId` + its listener set. Consumers: the viewport/engine sync rings
// the marker (useHoverEntity) so a textual reference lights up its spatial
// counterpart.
//
// Anchors:
//   plan-strategy §2 D-2: cluster 6 (store.ts:172-191)
//   research F-2: the useSyncExternalStore getter (getHoverEntity) and hook
//     (useHoverEntity) MUST stay in one file — the subscribe closure captures
//     hoverListeners directly, so splitting the chain would break it.
//   requirements AC-09: pure structural migration.
import { useSyncExternalStore } from 'react';
import type { EntityId } from '../types';

// Hover-highlight signal: a transient "the pointer is over a handle that refers
// to entity N" pulse. The viewport/engine sync rings that marker so a reference
// in text lights up its spatial counterpart.
let hoverId: EntityId | null = null;
const hoverListeners = new Set<() => void>();
export function setHoverEntity(id: EntityId | null): void {
  if (hoverId === id) return;
  hoverId = id;
  for (const fn of hoverListeners) fn();
}
export function getHoverEntity(): EntityId | null {
  return hoverId;
}
export function useHoverEntity(): EntityId | null {
  return useSyncExternalStore(
    (fn) => {
      hoverListeners.add(fn);
      return () => hoverListeners.delete(fn);
    },
    getHoverEntity,
    getHoverEntity,
  );
}
