// @forgeax/editor-shared — cross-layer shared runtime services and panel manifest
//
// This package breaks the dep cycle between editor-core, editor-panels, and
// editor-edit-runtime. It hosts the zustand store, entity ops, context menu
// service, dock bridge, and the EDITOR_PANELS panel manifest (SSOT for all
// dockable panel IDs).
//
// DAG: engine ← core ← shared ← panels ← edit-runtime / play-runtime

// ── Panel manifest (SSOT) ──
export { EDITOR_PANELS } from './manifest';
export type { EditorPanelId } from './manifest';

// ── Store (zustand singleton — bus, selection, scene persistence) ──
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
  setSceneId,
  setSelection,
  setSelectionMany,
  setAnimPreview,
  setHoverEntity,
  setFieldPreview,
  toggleSelection,
  onSelectionChange,
  onRenameRequest,
  requestRename,
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
  loadDocFromStorage,
  loadDocFromDisk,
  initSync,
  initDiskWatch,
  broadcastAssetsChanged,
  flushPendingSaveBeacon,
} from './store';

// ── Entity operations ──
export {
  deleteEntityCascade,
  deleteManyCascade,
  duplicateEntity,
  groupSelected,
  ungroupEntity,
  reparentEntity,
} from './ops';

// ── Context menu service ──
export { ContextMenuHost, showContextMenu } from './contextMenuService';
export type { MenuItemDef } from './contextMenuService';

// ── Dock bridge helpers ──
export { focusPanel, openSourcePanel } from './dock-bridge';