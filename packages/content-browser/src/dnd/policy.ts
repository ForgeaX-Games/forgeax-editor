// Content Browser DnD POLICY — the single place that answers the three
// gatekeeping questions for a move drag, so every surface (grid tile, tree row,
// breadcrumb) enforces identical rules:
//
//   1. canDrag(entry)            — may this subject be picked up at all?
//   2. ACCEPT_MATRIX             — which subject kinds may enter which target?
//   3. evaluateDrop(payload, t)  — is THIS drop legal, and if not, WHY?
//
// The reject REASON is a first-class value (not a boolean) so the UI can explain
// a refusal (point 3) via cursor/tooltip/toast instead of silently doing nothing.

import { dirOfPath } from '../content-browser-format';
import type {
  CBDragEntry,
  CBDragKind,
  CBDragPayload,
  CBDropTarget,
  CBDropTargetKind,
  DropRejectReason,
  DropVerdict,
} from './model';

/** Point 1: type-driven drag gate. A subject with no move path was already
 *  filtered by dragEntryForViewItem; here we additionally forbid dragging a
 *  root-level folder (empty path) which has no parent to move out of. */
export function canDrag(entry: CBDragEntry | null): entry is CBDragEntry {
  if (!entry) return false;
  if (entry.kind === 'folder' && entry.path === '') return false;
  return entry.path.length > 0;
}

/** Point 2: acceptable-region type config — what kind may drop into what. Each
 *  drop target advertises the set of drag kinds it will host. Kept as data so a
 *  future target (e.g. a "no-drop" pinned area) is a table edit, not a code fork. */
export const ACCEPT_MATRIX: Readonly<Record<CBDropTargetKind, ReadonlySet<CBDragKind>>> = {
  'folder-tile': new Set<CBDragKind>(['file', 'folder', 'asset']),
  'tree-folder': new Set<CBDragKind>(['file', 'folder', 'asset']),
  'grid-blank': new Set<CBDragKind>(['file', 'folder', 'asset']),
  'breadcrumb': new Set<CBDragKind>(['file', 'folder', 'asset']),
};

function normalizeTargetDir(target: CBDropTarget): string {
  return target.path;
}

/** Point 3: full drop legality with an explicit reason. Evaluated on dragover
 *  (via the same-window registry) AND on drop, so the hover cursor and the drop
 *  action never disagree. */
export function evaluateDrop(payload: CBDragPayload | null, target: CBDropTarget): DropVerdict {
  if (!payload || payload.entries.length === 0) {
    return { ok: false, reason: 'no-payload' };
  }
  const accepted = ACCEPT_MATRIX[target.kind];
  const targetDir = normalizeTargetDir(target);
  for (const entry of payload.entries) {
    if (!accepted.has(entry.kind)) return { ok: false, reason: 'unsupported-type' };
    if (entry.kind === 'folder') {
      if (entry.path === targetDir) return { ok: false, reason: 'self' };
      if (targetDir === entry.path || targetDir.startsWith(`${entry.path}/`)) {
        return { ok: false, reason: 'descendant' };
      }
    }
    if (dirOfPath(entry.path) === targetDir) return { ok: false, reason: 'same-parent' };
  }
  return { ok: true };
}

/** i18n keys for each refusal (point 3). Components resolve via t(); a raw
 *  English fallback keeps the message legible before locale entries land. */
export const DROP_REJECT_I18N: Readonly<Record<DropRejectReason, string>> = {
  'no-payload': 'editor.contentBrowser.dnd.reject.noPayload',
  'unsupported-type': 'editor.contentBrowser.dnd.reject.unsupportedType',
  'self': 'editor.contentBrowser.dnd.reject.self',
  'descendant': 'editor.contentBrowser.dnd.reject.descendant',
  'same-parent': 'editor.contentBrowser.dnd.reject.sameParent',
};

const DROP_REJECT_FALLBACK: Readonly<Record<DropRejectReason, string>> = {
  'no-payload': 'Nothing to move',
  'unsupported-type': "This item can't be dropped here",
  'self': "Can't drop a folder onto itself",
  'descendant': "Can't move a folder into its own subfolder",
  'same-parent': 'Already in this folder',
};

export function dropRejectFallback(reason: DropRejectReason): string {
  return DROP_REJECT_FALLBACK[reason];
}

/** Point 4 input: name collisions in the destination. Pure — the caller supplies
 *  the destination folder's existing child basenames (from the loaded disk tree),
 *  so this stays testable and free of IO. */
export interface MoveConflict {
  readonly path: string;
  readonly name: string;
}

export function findMoveConflicts(
  payload: CBDragPayload,
  targetChildNames: ReadonlySet<string>,
): MoveConflict[] {
  const conflicts: MoveConflict[] = [];
  for (const entry of payload.entries) {
    if (targetChildNames.has(entry.name)) conflicts.push({ path: entry.path, name: entry.name });
  }
  return conflicts;
}

/** Map a drag entry + destination dir to the gateway move op. Folders route to
 *  moveDirectory; files and asset source files route to moveSourceFile. */
export function moveOpForEntry(
  entry: CBDragEntry,
  targetDir: string,
): { kind: 'moveDirectory' | 'moveSourceFile'; path: string; targetDir: string } {
  const kind = entry.kind === 'folder' ? 'moveDirectory' : 'moveSourceFile';
  return { kind, path: entry.path, targetDir };
}
