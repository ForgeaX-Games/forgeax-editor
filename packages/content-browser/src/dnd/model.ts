// Content Browser drag-and-drop MODEL — the shared vocabulary for CB internal
// move DnD, kept framework-agnostic (no React, no gateway) so the policy and the
// per-surface hooks all speak one contract.
//
// Two channels carry a drag:
//   1. dataTransfer MIME (CB_MOVE_MIME) — the durable, cross-frame-safe payload
//      written on dragstart and read on drop.
//   2. an in-memory active-drag registry — because the HTML5 DnD spec forbids
//      reading dataTransfer.getData() during `dragover` (only `types` is
//      exposed), we mirror the payload in a module ref so drop TARGETS can
//      compute a full verdict (self / descendant / same-parent) WHILE hovering,
//      not just on drop. CB DnD is always same-window, so this ref is authoritative.

import type { CBViewItem } from '../types';

/** What kind of subject is being dragged. Drives canDrag + the accept matrix. */
export type CBDragKind = 'file' | 'folder' | 'asset';

/** One dragged subject. `path` is the game-relative move subject (folder/file
 *  path; for an asset its source file path). `guid` is present for assets. */
export interface CBDragEntry {
  readonly kind: CBDragKind;
  readonly path: string;
  readonly name: string;
  readonly guid?: string;
}

/** The full drag payload (supports multi-select, though v1 wiring may pass one). */
export interface CBDragPayload {
  /** Where the drag started — lets a drop target treat tree/grid symmetrically. */
  readonly source: 'grid' | 'tree';
  readonly entries: readonly CBDragEntry[];
}

/** The surfaces that can receive a move drop. */
export type CBDropTargetKind = 'folder-tile' | 'tree-folder' | 'grid-blank' | 'breadcrumb';

/** A resolved drop target: the destination PARENT directory (game-relative). */
export interface CBDropTarget {
  readonly kind: CBDropTargetKind;
  readonly path: string;
}

/** Why a drop is not allowed — surfaced to the user (point 3: explain refusals). */
export type DropRejectReason =
  | 'no-payload'
  | 'unsupported-type'
  | 'self'
  | 'descendant'
  | 'same-parent';

export type DropVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: DropRejectReason };

/** dataTransfer MIME for a CB internal move. Distinct from the copy-oriented
 *  `application/x-forgeax-file` / `-asset` payloads so a folder drop can tell a
 *  MOVE apart from a viewport-placement drag or an OS file import. */
export const CB_MOVE_MIME = 'application/x-forgeax-cb-move';

// ── active-drag registry (same-window mirror of the payload) ─────────────────
let activeDrag: CBDragPayload | null = null;

export function beginActiveDrag(payload: CBDragPayload): void {
  activeDrag = payload;
}

export function endActiveDrag(): void {
  activeDrag = null;
}

export function currentActiveDrag(): CBDragPayload | null {
  return activeDrag;
}

/** Serialize a payload onto a dragstart dataTransfer + prime the registry. */
export function writeDragPayload(
  dataTransfer: Pick<DataTransfer, 'setData' | 'effectAllowed'>,
  payload: CBDragPayload,
): void {
  dataTransfer.setData(CB_MOVE_MIME, JSON.stringify(payload));
  // A human-readable fallback so dropping onto a text field / external target is
  // at least legible rather than "[object Object]".
  dataTransfer.setData('text/plain', payload.entries.map((e) => `@${e.name}`).join(' '));
  dataTransfer.effectAllowed = 'move';
}

/** Read a payload from a drop dataTransfer, falling back to the registry when
 *  the MIME is unreadable (some browsers restrict getData in certain phases). */
export function readDragPayload(
  dataTransfer: Pick<DataTransfer, 'getData'>,
): CBDragPayload | null {
  try {
    const raw = dataTransfer.getData(CB_MOVE_MIME);
    if (raw) return JSON.parse(raw) as CBDragPayload;
  } catch {
    // fall through to the in-memory mirror
  }
  return currentActiveDrag();
}

/** True when a dragover event carries a CB internal move (readable via `types`,
 *  which — unlike getData — IS exposed during dragover). */
export function dragEventCarriesMove(types: readonly string[]): boolean {
  return types.includes(CB_MOVE_MIME);
}

/** Build a drag entry from a Content Browser view item. Returns null for a
 *  subject that has no movable disk path (e.g. a registry-only asset with no
 *  source file). */
export function dragEntryForViewItem(item: CBViewItem): CBDragEntry | null {
  if (item.type === 'folder') {
    return { kind: 'folder', path: item.path, name: item.name };
  }
  if (item.type === 'file') {
    return { kind: 'file', path: item.path, name: item.name };
  }
  const sourcePath = item.sourcePath;
  if (!sourcePath) return null;
  return { kind: 'asset', path: sourcePath, name: item.name, guid: item.guid };
}
