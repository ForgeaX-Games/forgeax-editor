// store/hover — the transient hover-highlight signal ("pointer over a handle
// that refers to entity N").
//
// State: `hoverId` + its listener set. Consumers: the viewport/engine sync rings
// the marker (useHoverEntity) so a textual reference lights up its spatial
// counterpart.
//
// Anchors:
//   plan-strategy §2 D-2: cluster 6 (store.ts:172-191)
//   plan-strategy §2 D-1: setHoverEntity is a TRANSIENT-domain op — the body is
//     the applier, registered into transientAppliers; the setter dispatches (M2
//     m2-w9). Transient ops go through the one gateway door but leave no trace
//     (no undo, no ledger) — the applier fires its own listeners.
//   research F-2: the useSyncExternalStore getter (getHoverEntity) and hook
//     (useHoverEntity) MUST stay in one file — the subscribe closure captures
//     hoverListeners directly, so splitting the chain would break it.
//   requirements AC-03: transient goes through gateway, leaves no trace.
import { useSyncExternalStore } from 'react';
import type { EditorOp, EntityId } from '../types';
import { gateway } from './gateway';
import { transientAppliers } from '../io/appliers';

// Hover-highlight signal: a transient "the pointer is over a handle that refers
// to entity N" pulse. The viewport/engine sync rings that marker so a reference
// in text lights up its spatial counterpart.
let hoverId: EntityId | null = null;
const hoverListeners = new Set<() => void>();

// Transient applier (M2 D-1): setHoverEntity body, registered into the transient
// table. No inverse, no ledger — the gateway records nothing for transient ops.
function applySetHoverEntity(op: EditorOp): { ok: true } {
  const id = (op as { id: EntityId | null }).id;
  if (hoverId !== id) {
    hoverId = id;
    for (const fn of hoverListeners) fn();
  }
  return { ok: true };
}
transientAppliers.set('setHoverEntity', applySetHoverEntity);

export function setHoverEntity(id: EntityId | null): void {
  gateway.dispatch({ kind: 'setHoverEntity', id });
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
