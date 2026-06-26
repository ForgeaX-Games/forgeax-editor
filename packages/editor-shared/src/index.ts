// @forgeax/editor-shared — alias barrel for @forgeax/editor-core
//
// After Wave A cleanup, editor-shared is a pass-through barrel. All business
// source files moved to editor-core. The package is kept for backward compat
// so existing consumers (@forgeax/editor-edit-runtime, @forgeax/editor-panels)
// keep their import paths unchanged (plan-strategy §2 D-7).

// ── Panel manifest (SSOT) ──
export { EDITOR_PANELS } from '@forgeax/editor-core';
export type { EditorPanelId } from '@forgeax/editor-core';

// ── Store (bus singleton — bus, selection, scene persistence) ──
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
  requestAddAssetsToChat,
  requestAddAssetToScene,
  useDocVersion,
  useMainConnected,
  useGizmoMode,
  useSelection,
  useSelectionList,
  useHoverEntity,
  useFieldPreview,
  loadDocFromStorage,
  loadDocFromDisk,
  initSync,
  initDiskWatch,
  initSceneList,
  getSceneFile,
  getSceneList,
  onSceneListChange,
  useSceneList,
  useSceneFile,
  switchSceneFile,
  createSceneFile,
  requestOpenScene,
  readPlayConfig,
  writePlayConfig,
  broadcastAssetsChanged,
  renameAssetInPack,
  duplicateAssetInPack,
  deleteAsset,
  createDirectory,
  generateAssetGuid,
  flushPendingSaveBeacon,
  cancelPendingDiskSave,
  setAssetSelection,
  getAssetSelection,
  useAssetSelection,
} from '@forgeax/editor-core';
export type { SceneFileEntry, PlayConfig, SelectedAsset, AssetChatRef } from '@forgeax/editor-core';

// ── Entity operations ──
export {
  deleteEntityCascade,
  deleteManyCascade,
  duplicateEntity,
  groupSelected,
  ungroupEntity,
  reparentEntity,
} from '@forgeax/editor-core';

// ── Context menu service ──
export { ContextMenuHost, showContextMenu } from '@forgeax/editor-core';
export type { MenuItemDef } from '@forgeax/editor-core';

// ── Dock bridge helpers ──
export { focusPanel, openSourcePanel } from '@forgeax/editor-core';