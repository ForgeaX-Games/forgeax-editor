// store/field-preview — the live scalar published while a viewport gizmo drags.
//
// State: `fieldPreview` ({id,key,value}) + its listener set. Consumers: the
// viewport publishes the live value (keyed by a namespaced field id like
// 'Transform.rot.y') so the Inspector tracks it (useFieldPreview) WITHOUT
// committing a command.
//
// Anchors:
//   plan-strategy §2 D-2: cluster 7 (store.ts:196-221)
//   research F-2: the useSyncExternalStore getter (getFieldPreview) and hook
//     (useFieldPreview) MUST stay in one file — the subscribe closure captures
//     fieldListeners directly.
//   requirements AC-09: pure structural migration.
import { useSyncExternalStore } from 'react';
import type { EntityId } from '../types';

// Transient field-preview signal: while a viewport gizmo is being dragged it
// publishes the live scalar (keyed by a namespaced field id like
// 'Transform.rot.y') so the Inspector tracks it without committing a command.
let fieldPreview: { id: EntityId; key: string; value: number } | null = null;
const fieldListeners = new Set<() => void>();
export function setFieldPreview(id: EntityId | null, key?: string, value?: number): void {
  if (id === null || key === undefined) {
    if (fieldPreview === null) return;
    fieldPreview = null;
  } else {
    const v = value ?? 0;
    if (fieldPreview && fieldPreview.id === id && fieldPreview.key === key && fieldPreview.value === v) return;
    fieldPreview = { id, key, value: v };
  }
  for (const fn of fieldListeners) fn();
}
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
