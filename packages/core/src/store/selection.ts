// store/selection — the transient entity-selection set (deixis handle source).
//
// feat-20260707-editor-world-fork M3 (I1 / AC-10): selection is now
// Set<EntityHandle>. The runtime editor identity IS the engine handle, so the
// selection store holds live engine handles (not legacy ids). Insertion order is
// preserved by Set semantics; the LAST inserted handle is the "primary" (drives
// single-target panels like Inspector). Consumers: panels (via useSelection /
// useSelectionList), the viewport gizmo (onSelectionChange), and the
// enterPlay/exitPlay lifecycle seam (clearSelection — D-11).
//
// Anchors:
//   requirements AC-10: selection is Set<EntityHandle>, all consumers migrated,
//     play/stop each clear selection
//   plan-strategy §2 D-1: setSelection/toggleSelection/setSelectionMany are
//     SESSION-domain ops — the setter bodies are the appliers, registered into
//     sessionAppliers.
//   plan-strategy D-11: enterPlay/exitPlay clear the selection store directly
//     (not via dispatch — lifecycle semantics, not an edit op)
//   research Finding 6: post trace-ioc t22 selection.ts is applier + read side only
import { useSyncExternalStore } from 'react';
import type { EditorOp } from '../types';
import type { EntityHandle } from '../scene/scene-types';
import { sessionAppliers } from '../io/appliers';

// Selection is a Set of engine handles; the LAST inserted handle is the
// "primary" (drives single-target panels like Inspector). Multi-select feeds
// deixis (reference many). Set preserves insertion order, so the primary is the
// last element of the iteration.
let selectionSet: Set<EntityHandle> = new Set();
const selectionListeners = new Set<() => void>();

// Cross-window selection sync via localStorage (works across Tauri WebviewWindow
// processes, where BroadcastChannel can't reach). Dev-only runaway-propagation
// net: if selection emits a storm within a short window it almost always means a
// cross-window echo loop regressed. Warns once per window so it's visible without
// re-instrumenting. No-op in production.
let _emitWindowStart = 0;
let _emitCount = 0;
let _emitWarned = false;
function emitSelection(): void {
  // editor-core is typechecked with plain tsc (Bun import.meta types, no
  // vite/client), so `import.meta.env` isn't on ImportMeta here — cast locally.
  // At runtime this module is Vite-bundled, where `import.meta.env.DEV` is real.
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
    const now = Date.now();
    if (now - _emitWindowStart > 1000) { _emitWindowStart = now; _emitCount = 0; _emitWarned = false; }
    if (++_emitCount > 32 && !_emitWarned) {
      _emitWarned = true;
      // eslint-disable-next-line no-console
      console.warn(`[sel-sync] runaway selection propagation: ${_emitCount} emits within 1s — likely a cross-window echo loop (see docs/design/editor-cross-window-selection-sync-loop.md)`);
    }
  }
  for (const fn of selectionListeners) fn();
}

/** The primary selection = the LAST inserted handle (Set preserves order). */
export function getSelection(): EntityHandle | null {
  let last: EntityHandle | null = null;
  for (const h of selectionSet) last = h;
  return last;
}
/** The full selection Set (live reference — do not mutate; treat as read-only). */
export function getSelectionList(): Set<EntityHandle> {
  return selectionSet;
}
export function isSelected(handle: EntityHandle): boolean {
  return selectionSet.has(handle);
}

// ── Session appliers (D-1): the mutation bodies, registered into the session
// table. These are the ONLY code that touches selectionSet; UI/AI dispatch ops
// that route here.
function applySetSelection(op: EditorOp): { ok: true } {
  const id = (op as { id: EntityHandle | null }).id;
  if (id === null) {
    if (selectionSet.size !== 0) { selectionSet = new Set(); emitSelection(); }
  } else if (!(selectionSet.size === 1 && selectionSet.has(id))) {
    selectionSet = new Set([id]);
    emitSelection();
  }
  return { ok: true };
}
function applyToggleSelection(op: EditorOp): { ok: true } {
  const id = (op as unknown as { id: EntityHandle }).id;
  const next = new Set(selectionSet);
  if (next.has(id)) {
    next.delete(id);
  } else {
    // Re-insert so a toggled-on handle becomes the LAST element (primary).
    next.add(id);
  }
  selectionSet = next;
  emitSelection();
  return { ok: true };
}
function applySetSelectionMany(op: EditorOp): { ok: true } {
  selectionSet = new Set((op as unknown as { ids: EntityHandle[] }).ids);
  emitSelection();
  return { ok: true };
}
sessionAppliers.set('setSelection', applySetSelection);
sessionAppliers.set('toggleSelection', applyToggleSelection);
sessionAppliers.set('setSelectionMany', applySetSelectionMany);

// M3 t22 (trace-ioc): the write-side sugar setters were dispatch-only zombie
// exports — deleted; callers dispatch through the one gateway door directly.
// Read-side pub/sub (getSelection / getSelectionList / onSelectionChange /
// useSelection) is orthogonal and stays. The session appliers above remain the
// mutation bodies (registered into sessionAppliers).

function subscribeSelection(fn: () => void): () => void {
  selectionListeners.add(fn);
  return () => selectionListeners.delete(fn);
}

/** Non-React selection subscription (the viewport gizmo follows the selection). */
export const onSelectionChange = subscribeSelection;

export function useSelection(): EntityHandle | null {
  return useSyncExternalStore(subscribeSelection, getSelection, getSelection);
}
export function useSelectionList(): Set<EntityHandle> {
  return useSyncExternalStore(subscribeSelection, getSelectionList, getSelectionList);
}

/**
 * Directly clear selection — lifecycle seam for enterPlay/exitPlay (D-11).
 *
 * Not an edit op, not dispatched, not recorded in ledger/undo. enterPlay/exitPlay
 * call this directly because selection clearing is lifecycle semantics, not an
 * edit action — the selection store is transient view state and handles from a
 * previous world are invalid after a world switch.
 */
export function clearSelection(): void {
  if (selectionSet.size !== 0) {
    selectionSet = new Set();
    emitSelection();
  }
}
