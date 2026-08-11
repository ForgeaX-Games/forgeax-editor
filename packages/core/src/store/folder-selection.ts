// store/folder-selection — session-domain path selection state and applier.
//
// Tracks the currently-selected filesystem paths (folders AND source files) in
// the Content Browser. Each item carries its `kind` ('dir' | 'file') so the
// keyboard router's Delete path can dispatch the correct op per type:
//   - 'dir'  → deleteDirectory
//   - 'file' → deleteSourceFile
//
// Parallel to asset-selection and entity-selection: clicks dispatch a
// `setFolderSelection` session op through the one gateway door, keeping AI
// parity (charter compliance). The applier writes module-level state and emits an
// event that `last-selection-domain` listens to for triple-domain routing.
//
// Anchors:
//   D3a: folder/file delete — setFolderSelection session op + lastSelectionDomain
//   G-2: AI can dispatch setFolderSelection to select paths programmatically.
//   Plan-E: typed items + dedup guard (empty→empty no-op, prevents domain pollution).

import { useSyncExternalStore } from 'react';
import { registerApplier } from '../io/appliers';
// Single-active-selection-domain: selecting a path clears any entity selection so
// Delete / blank-click resolve to one target. Direct clear (guarded on non-empty)
// goes through the shared selection-domain seam.
import {
  clearSelectionDomains,
  registerSelectionDomainClear,
} from './selection-domain-clears';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PathSelectionItem {
  path: string;
  kind: 'dir' | 'file';
}

// ── Module-level state ────────────────────────────────────────────────────────

let selectedItems: PathSelectionItem[] = [];

/** Plain read of the current path selection (typed items). */
export function getPathSelectionList(): PathSelectionItem[] {
  return selectedItems;
}

/** Legacy plain-path read (backward compat with existing callers). */
export function getFolderSelectionList(): string[] {
  return selectedItems.map((i) => i.path);
}

// ── Change notification ───────────────────────────────────────────────────────

type FolderSelectionListener = () => void;
const folderListeners = new Set<FolderSelectionListener>();

/** Subscribe to folder/file selection changes. */
export function onFolderSelectionChange(fn: FolderSelectionListener): () => void {
  folderListeners.add(fn);
  return () => { folderListeners.delete(fn); };
}

function emit(): void {
  for (const fn of folderListeners) fn();
}

// ── React hooks ───────────────────────────────────────────────────────────────

let _cachedRef: PathSelectionItem[] = selectedItems;
let _cachedSet: Set<string> = new Set();

function getSnapshot(): Set<string> {
  if (selectedItems !== _cachedRef) {
    _cachedRef = selectedItems;
    _cachedSet = new Set(selectedItems.map((i) => i.path));
  }
  return _cachedSet;
}

/** Reactively read the current path selection as a path-Set for O(1) lookup. */
export function useFolderSelectionSet(): Set<string> {
  return useSyncExternalStore(onFolderSelectionChange, getSnapshot);
}

// ── Dedup helper ──────────────────────────────────────────────────────────────

function sameItems(a: PathSelectionItem[], b: PathSelectionItem[]): boolean {
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  const bSet = new Set(b.map((x) => `${x.kind}:${x.path}`));
  return a.every((x) => bSet.has(`${x.kind}:${x.path}`));
}

// ── Session applier ───────────────────────────────────────────────────────────

registerApplier('session', 'setFolderSelection', (op) => {
  const raw = op as { paths?: string[]; items?: PathSelectionItem[] };
  // Support both shapes: new typed `items` OR legacy `paths` (backward compat).
  let next: PathSelectionItem[];
  if (raw.items && Array.isArray(raw.items)) {
    next = raw.items;
  } else {
    // Legacy: plain paths default to 'dir' kind.
    next = (raw.paths ?? []).map((p) => ({ path: p, kind: 'dir' as const }));
  }
  // Dedup: don't emit when nothing changed (prevents domain pollution on empty→empty).
  if (sameItems(selectedItems, next)) {
    return { ok: true };
  }
  // Only a forward (non-empty) path selection is the active domain — clear the
  // entity selection FIRST, then emit paths LAST so lastSelectionDomain = 'folder'.
  // An empty set (deselect) must NOT clear the entity selection.
  if (next.length > 0) clearSelectionDomains('entity');
  selectedItems = next;
  emit();
  return { ok: true };
});

/**
 * Directly clear the path selection — lifecycle/coordination seam. Not an edit op,
 * not dispatched, not recorded in ledger/undo, and does NOT advance
 * lastSelectionDomain. Used by the single-active-domain clears (selecting an
 * entity) and by blank-area deselect handlers.
 */
export function clearFolderSelection(): void {
  if (selectedItems.length !== 0) {
    selectedItems = [];
    emit();
  }
}

registerSelectionDomainClear('folder', clearFolderSelection);
