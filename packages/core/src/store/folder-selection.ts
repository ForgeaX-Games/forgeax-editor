// store/folder-selection — session-domain folder selection state and applier.
//
// Parallel to asset-selection and entity-selection: folder clicks dispatch a
// `setFolderSelection` session op through the one gateway door, keeping AI
// parity (北极星合规). The applier writes module-level state and emits an
// event that `last-selection-domain` listens to for triple-domain routing.
//
// Anchors:
//   D3a: folder delete todo — setFolderSelection session op + lastSelectionDomain 三值化
//   G-2: AI can dispatch setFolderSelection to select a folder programmatically.

import { useSyncExternalStore } from 'react';
import { sessionAppliers } from '../io/appliers';

// ── Module-level state ────────────────────────────────────────────────────────

let selectedFolders: string[] = [];

/** Plain read of the current folder selection (relative paths). */
export function getFolderSelectionList(): string[] {
  return selectedFolders;
}

// ── Change notification ───────────────────────────────────────────────────────

type FolderSelectionListener = () => void;
const folderListeners = new Set<FolderSelectionListener>();

/** Subscribe to folder selection changes. */
export function onFolderSelectionChange(fn: FolderSelectionListener): () => void {
  folderListeners.add(fn);
  return () => { folderListeners.delete(fn); };
}

function emit(): void {
  for (const fn of folderListeners) fn();
}

// ── React hooks ───────────────────────────────────────────────────────────────

let _cachedArr: string[] = selectedFolders;
let _cachedSet: Set<string> = new Set();

function getSnapshot(): Set<string> {
  if (selectedFolders !== _cachedArr) {
    _cachedArr = selectedFolders;
    _cachedSet = new Set(selectedFolders);
  }
  return _cachedSet;
}

/** Reactively read the current folder selection as a Set for O(1) lookup. */
export function useFolderSelectionSet(): Set<string> {
  return useSyncExternalStore(onFolderSelectionChange, getSnapshot);
}

// ── Session applier ───────────────────────────────────────────────────────────

sessionAppliers.set('setFolderSelection', (op) => {
  const { paths } = op as { paths: string[] };
  selectedFolders = paths ?? [];
  emit();
  return { ok: true };
});
