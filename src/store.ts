import { useSyncExternalStore } from 'react';
import { EditorBus } from './core/bus';
import { createDocument } from './core/document';
import type { EditorCommand, EntityId, SceneDocument } from './core/types';

// App-level singletons. The bus is the authoritative mutable path; selection is
// transient view state (NOT a command) — but selecting is exactly what turns a
// vague "this" into a concrete pointing handle for the AI (deixis).
//
// Ported (trimmed) from the unveil-studio prototype: Edit-only — the Play
// snapshot / runtime-systems half of the prototype store is dropped here because
// in forgeax the *engine itself* runs Play mode (see interface ▶ Play). The Edit
// surface keeps the authored doc static and projects it onto the forgeax world.
export const bus = new EditorBus(createDocument());

// Selection is a list; the LAST element is the "primary" (drives single-target
// panels like Inspector). Multi-select feeds deixis (reference many).
let selectionList: EntityId[] = [];
const selectionListeners = new Set<() => void>();

function emitSelection(): void {
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

export function setSelection(id: EntityId | null): void {
  if (id === null) {
    if (selectionList.length === 0) return;
    selectionList = [];
  } else {
    if (selectionList.length === 1 && selectionList[0] === id) return;
    selectionList = [id];
  }
  emitSelection();
}

/** Shift/Ctrl-click semantics: toggle membership, keep last-clicked as primary. */
export function toggleSelection(id: EntityId): void {
  selectionList = selectionList.includes(id) ? selectionList.filter((x) => x !== id) : [...selectionList, id];
  emitSelection();
}

export function setSelectionMany(ids: EntityId[]): void {
  selectionList = [...ids];
  emitSelection();
}

function subscribeSelection(fn: () => void): () => void {
  selectionListeners.add(fn);
  return () => selectionListeners.delete(fn);
}

export function useSelection(): EntityId | null {
  return useSyncExternalStore(subscribeSelection, getSelection, getSelection);
}
export function useSelectionList(): EntityId[] {
  return useSyncExternalStore(subscribeSelection, getSelectionList, getSelectionList);
}

// Frame-request signal: "center the viewport on the primary selection" pulse.
// In editor-runtime the forgeax camera consumes this (engine/sync.ts).
const frameListeners = new Set<() => void>();
export function requestFrame(): void {
  for (const fn of frameListeners) fn();
}
export function onFrameRequest(fn: () => void): () => void {
  frameListeners.add(fn);
  return () => frameListeners.delete(fn);
}

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

// Hover-highlight signal: a transient "the pointer is over a handle that refers
// to entity N" pulse. The viewport/engine sync rings that marker so a reference
// in text lights up its spatial counterpart.
let hoverId: EntityId | null = null;
const hoverListeners = new Set<() => void>();
export function setHoverEntity(id: EntityId | null): void {
  if (hoverId === id) return;
  hoverId = id;
  for (const fn of hoverListeners) fn();
}
export function getHoverEntity(): EntityId | null {
  return hoverId;
}
export function useHoverEntity(): EntityId | null {
  return useSyncExternalStore(
    (fn) => {
      hoverListeners.add(fn);
      return () => hoverListeners.delete(fn);
    },
    getHoverEntity,
    getHoverEntity,
  );
}

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

// Reference-request signal: "pin entity N into the ForgeaX chat context". The
// chat panel lives in the parent interface shell (we are an iframe), so we post
// a deixis handle up via the VAG postMessage channel rather than owning ref
// state locally — exactly the "human points → AI gets a concrete handle" path.
export function requestRefEntity(id: EntityId): void {
  const node = bus.doc.entities[id];
  if (!node) return;
  const handle = {
    kind: 'entity' as const,
    id,
    name: node.name,
    components: Object.keys(node.components),
    ...(node.source ? { source: node.source } : {}),
  };
  try {
    window.parent?.postMessage({ type: 'VAG_EDITOR_REF', payload: handle }, '*');
  } catch {
    /* cross-origin — non-fatal */
  }
}

// Re-render hook: bumps a version on every bus change so panels re-read doc.
let docVersion = 0;
const docListeners = new Set<() => void>();
bus.subscribe(() => {
  docVersion++;
  for (const fn of docListeners) fn();
});
function subscribeDoc(fn: () => void): () => void {
  docListeners.add(fn);
  return () => docListeners.delete(fn);
}
export function useDocVersion(): number {
  return useSyncExternalStore(subscribeDoc, () => docVersion, () => docVersion);
}

export function dispatch(cmd: EditorCommand): void {
  bus.dispatch(cmd);
}

// ── Scene document persistence (autosave/restore) ─────────────────────────────
const DOC_KEY = 'forgeax:editor:doc:v1';

export function loadDocFromStorage(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    const raw = localStorage.getItem(DOC_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.entities) {
      bus.doc = parsed;
      docVersion++;
      for (const fn of docListeners) fn();
      return true;
    }
  } catch {
    /* corrupt → ignore, fall back to seed */
  }
  return false;
}

// Save synchronously on every change so a reload/navigation right after an edit
// never loses it (the doc is small; cost is negligible at this scale).
bus.subscribe(() => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(DOC_KEY, JSON.stringify(bus.doc));
  } catch {
    /* quota / unavailable — non-fatal */
  }
});

/** Replace the entire authored document (scene load/import). Resets selection
 * and undo history since old inverses no longer apply to the new doc. */
export function replaceDoc(doc: SceneDocument): void {
  bus.replaceDoc(doc);
  selectionList = [];
  emitSelection();
  docVersion++;
  for (const fn of docListeners) fn();
}

export function clearDocStorage(): void {
  try {
    localStorage.removeItem(DOC_KEY);
  } catch {
    /* noop */
  }
}
