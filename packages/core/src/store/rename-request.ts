// store/rename-request — the "enter inline-rename on Hierarchy row N" signal.
//
// State: `renameListeners` (fire-with-id, no retained value). Consumers: F2 /
// any panel calls requestRename(id); the Hierarchy row subscribes via
// onRenameRequest to enter inline-rename without being globally focusable.
//
// Anchors:
//   plan-strategy §2 D-2: cluster 5 (store.ts:160-167)
//   requirements AC-09: pure structural migration.
import type { EntityId } from '../types';

// Rename-request signal: F2 (or any panel) asks the Hierarchy row for `id` to
// enter inline-rename mode, without that row being globally focusable.
const renameListeners = new Set<(id: EntityId) => void>();
export function requestRename(id: EntityId): void {
  for (const fn of renameListeners) fn(id);
}
export function onRenameRequest(fn: (id: EntityId) => void): () => void {
  renameListeners.add(fn);
  return () => renameListeners.delete(fn);
}
