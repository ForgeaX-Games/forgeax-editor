// @forgeax/editor-edit-runtime — Edit mode main entry
//
// This package bundles the editor Edit-mode vite app:
//   - Engine boot + camera + skylight + viewport
//   - React editor chrome (DockManager, panels, context menu)
//   - Zustand store (bus, selection, scene persistence)
//   - Sync channel bridge
//
// Re-exported for AppKit / standalone consumers.

// ── Store (selected subset) ──
export {
  bus,
  dispatch,
  getSceneId,
  getSelection,
  getSelectionList,
  getGizmoMode,
  getAnimPreview,
  replaceDoc,
  saveDocToDisk,
  setGizmoMode,
  setSelection,
  setSelectionMany,
  setAnimPreview,
  setHoverEntity,
  setFieldPreview,
  toggleSelection,
  onSelectionChange,
  onRenameRequest,
  onGizmoModeChange,
  onAnimPreview,
  onPopoutClosed,
  onPopoutGeom,
  announcePopoutClosing,
  announcePopoutGeom,
  requestFrame,
  requestRefComponent,
  requestRefAsset,
  requestRefEntity,
  useDocVersion,
  useGizmoMode,
  useSelection,
  useSelectionList,
  useHoverEntity,
  useFieldPreview,
} from './store';

// ── Operations ──
export {
  deleteEntityCascade,
  deleteManyCascade,
  duplicateEntity,
  groupSelected,
  ungroupEntity,
  reparentEntity,
} from './ops';

// ── UI / Components ──
export { DockManager } from './Dock';
export { DetachedPanel } from './DetachedPanel';
export { EditorApp } from './EditorApp';
export { ViewportBar } from './ViewportBar';
export { ViewportHints } from './ViewportHints';
export { ContextMenuHost, showContextMenu } from './contextMenuService';
export type { MenuItemDef } from './contextMenuService';

// ── Dock helpers ──
export { focusPanel, openSourcePanel } from './dock-bridge';

// ── Engine ──
export { createEngineSync } from './engine/sync';
export { setupEditorSkylight } from './engine/skylight';
export { createViewport } from './engine/viewport';
