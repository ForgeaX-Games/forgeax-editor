// store/selection — the transient entity-selection list (deixis handle source).
//
// State: `selectionList` (LAST element = primary, drives single-target panels)
// plus its listener set and the DEV runaway-propagation net. Consumers: panels
// (via useSelection/useSelectionList), the viewport gizmo (onSelectionChange),
// and scene-persistence's replaceDoc (which clears selection on a doc swap via
// the public setSelectionMany([]) — so `selectionList`/`emitSelection` stay
// private to this module, NOT exported as internal seams).
//
// Anchors:
//   plan-strategy §2 D-2: cluster 2 (store.ts:53-145)
//   plan-strategy §2 D-1: setSelection/toggleSelection/setSelectionMany are
//     SESSION-domain ops — the setter bodies are the appliers, registered into
//     sessionAppliers; the public setters now dispatch through the gateway (M2
//     m2-w6). Setters stay exported (UI still calls them directly); M3 seals them
//     private. "Change the door, not the body" (spec §11.3).
//   research F-2: useSyncExternalStore getter+hook kept in one file
//   requirements AC-02/AC-09: session op → ledger only, AI-dispatchable.
import { useSyncExternalStore } from 'react';
import type { EditorOp, EntityId } from '../types';
import { gateway } from './gateway';
import { sessionAppliers } from '../io/appliers';

// Selection is a list
// Selection is a list; the LAST element is the "primary" (drives single-target
// panels like Inspector). Multi-select feeds deixis (reference many).
let selectionList: EntityId[] = [];
const selectionListeners = new Set<() => void>();

// Cross-window selection sync via localStorage (works across Tauri WebviewWindow
// processes, where BroadcastChannel can't reach). Persisted per scene; other
// windows pick it up via a `storage` event (see initSync). Guarded so applying a
// remote selection doesn't echo back.
// Dev-only runaway-propagation// Dev-only runaway-propagation net: if selection emits storm within a short
// window it almost always means a cross-window echo loop regressed. Warns once
// per window so it's visible without re-instrumenting. No-op in production.
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

export function getSelection(): EntityId | null {
  return selectionList.length ? selectionList[selectionList.length - 1]! : null;
}
export function getSelectionList(): EntityId[] {
  return selectionList;
}
export function isSelected(id: EntityId): boolean {
  return selectionList.includes(id);
}

// ── Session appliers (M2 D-1): the mutation bodies, registered into the session
// table. These are the ONLY code that touches selectionList; the public setters
// below dispatch ops that route here. Bodies are the original setter bodies
// verbatim ("change the door, not the body").
function applySetSelection(op: EditorOp): { ok: true } {
  const id = (op as { id: EntityId | null }).id;
  if (id === null) {
    if (selectionList.length !== 0) { selectionList = []; emitSelection(); }
  } else if (!(selectionList.length === 1 && selectionList[0] === id)) {
    selectionList = [id];
    emitSelection();
  }
  return { ok: true };
}
function applyToggleSelection(op: EditorOp): { ok: true } {
  const id = (op as { id: EntityId }).id;
  selectionList = selectionList.includes(id) ? selectionList.filter((x) => x !== id) : [...selectionList, id];
  emitSelection();
  return { ok: true };
}
function applySetSelectionMany(op: EditorOp): { ok: true } {
  selectionList = [...(op as { ids: EntityId[] }).ids];
  emitSelection();
  return { ok: true };
}
sessionAppliers.set('setSelection', applySetSelection);
sessionAppliers.set('toggleSelection', applyToggleSelection);
sessionAppliers.set('setSelectionMany', applySetSelectionMany);

export function setSelection(id: EntityId | null): void {
  gateway.dispatch({ kind: 'setSelection', id });
}

/** Shift/Ctrl-click semantics: toggle membership, keep last-clicked as primary. */
export function toggleSelection(id: EntityId): void {
  gateway.dispatch({ kind: 'toggleSelection', id });
}

export function setSelectionMany(ids: EntityId[]): void {
  gateway.dispatch({ kind: 'setSelectionMany', ids });
}

function subscribeSelection(fn: () => void): () => void {
  selectionListeners.add(fn);
  return () => selectionListeners.delete(fn);
}

/** Non-React selection subscription (the viewport gizmo follows the selection). */
export const onSelectionChange = subscribeSelection;

export function useSelection(): EntityId | null {
  return useSyncExternalStore(subscribeSelection, getSelection, getSelection);
}
export function useSelectionList(): EntityId[] {
  return useSyncExternalStore(subscribeSelection, getSelectionList, getSelectionList);
}
