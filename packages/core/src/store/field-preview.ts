// store/field-preview — the live scalar published while a viewport gizmo drags.
//
// State: `fieldPreview` ({id,key,value}) + its listener set. Consumers: the
// viewport publishes the live value (keyed by a namespaced field id like
// 'Transform.rot.y') so the Inspector tracks it (useFieldPreview) WITHOUT
// committing a command.
//
// Anchors:
//   plan-strategy §2 D-2: cluster 7 (store.ts:196-221)
//   plan-strategy §2 D-1: setFieldPreview is a TRANSIENT-domain op — the body is
//     the applier, registered into transientAppliers; the setter dispatches (M2
//     m2-w9). Transient: no undo, no ledger.
//   research F-2: the useSyncExternalStore getter (getFieldPreview) and hook
//     (useFieldPreview) MUST stay in one file — the subscribe closure captures
//     fieldListeners directly.
//   requirements AC-03: transient goes through gateway, leaves no trace.
import { useSyncExternalStore } from 'react';
import type { EditorOp, EntityId } from '../types';
import { transientAppliers } from '../io/appliers';

// Transient field-preview signal: while a viewport gizmo is being dragged it
// publishes the live scalar (keyed by a namespaced field id like
// 'Transform.rot.y') so the Inspector tracks it without committing a command.
let fieldPreview: { id: EntityId; key: string; value: number } | null = null;
const fieldListeners = new Set<() => void>();

// Transient applier (M2 D-1): setFieldPreview body, registered into the transient
// table. The op payload carries id/key/value; the early-return no-op guards are
// preserved verbatim ("change the door, not the body").
function applySetFieldPreview(op: EditorOp): { ok: true } {
  const o = op as { id: EntityId | null; key?: string; value?: number };
  if (o.id === null || o.key === undefined) {
    if (fieldPreview === null) return { ok: true };
    fieldPreview = null;
  } else {
    const v = o.value ?? 0;
    if (fieldPreview && fieldPreview.id === o.id && fieldPreview.key === o.key && fieldPreview.value === v) return { ok: true };
    fieldPreview = { id: o.id, key: o.key, value: v };
  }
  for (const fn of fieldListeners) fn();
  return { ok: true };
}
transientAppliers.set('setFieldPreview', applySetFieldPreview);

// M3 t22 (S10 / AC-21/22): setFieldPreview write-side sugar deleted — callers
// dispatch gateway.dispatch({ kind: 'setFieldPreview', id, key, value }) directly.
// Read-side (getFieldPreview / useFieldPreview) stays.
export function getFieldPreview(): { id: EntityId; key: string; value: number } | null {
  return fieldPreview;
}
export function useFieldPreview(): { id: EntityId; key: string; value: number } | null {
  return useSyncExternalStore(
    (fn) => {
      fieldListeners.add(fn);
      return () => fieldListeners.delete(fn);
    },
    getFieldPreview,
    getFieldPreview,
  );
}
