// store/rename-request — the "enter inline-rename on Hierarchy row N" signal.
//
// State: `renameListeners` (fire-with-id, no retained value). Consumers: F2 /
// any panel calls requestRename(id); the Hierarchy row subscribes via
// onRenameRequest to enter inline-rename without being globally focusable.
//
// Anchors:
//   plan-strategy §2 D-2: cluster 5 (store.ts:160-167)
//   plan-strategy §2 D-1: requestRename is a SESSION-domain op — the body is the
//     applier, registered into sessionAppliers; the setter dispatches (M2 m2-w7).
//     onRenameRequest has a real consumer (Hierarchy row) and is kept.
//   requirements AC-02: session op, AI-dispatchable, ledger only.
import type { EditorOp, EntityId } from '../types';
import { gateway } from './gateway';
import { sessionAppliers } from '../io/appliers';

// Rename-request signal: F2 (or any panel) asks the Hierarchy row for `id` to
// enter inline-rename mode, without that row being globally focusable.
const renameListeners = new Set<(id: EntityId) => void>();

// Session applier (M2 D-1): fire-with-id, no retained value, no inverse.
function applyRequestRename(op: EditorOp): { ok: true } {
  const id = (op as { entity: EntityId }).entity;
  for (const fn of renameListeners) fn(id);
  return { ok: true };
}
sessionAppliers.set('requestRename', applyRequestRename);

export function requestRename(id: EntityId): void {
  gateway.dispatch({ kind: 'requestRename', entity: id });
}
export function onRenameRequest(fn: (id: EntityId) => void): () => void {
  renameListeners.add(fn);
  return () => renameListeners.delete(fn);
}
