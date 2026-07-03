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
  replaceDoc,
  saveDocToDisk,
  setGizmoMode,
  setSceneId,
  setSelection,
  setSelectionMany,
  setHoverEntity,
  setFieldPreview,
  toggleSelection,
  onSelectionChange,
  onRenameRequest,
  requestRename,
  onGizmoModeChange,
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
  getLoadedSceneRoot,
  rebindLoadedScene,
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
  onAssetSelectionChange,
  publishMeshStats,
  getMeshStats,
  useMeshStats,
} from '@forgeax/editor-core';
export type { SceneFileEntry, PlayConfig, SelectedAsset, AssetChatRef, MeshStats } from '@forgeax/editor-core';

// ── Entity operations ──
export {
  deleteEntityCascade,
  deleteManyCascade,
  duplicateEntity,
  groupSelected,
  ungroupEntity,
  reparentEntity,
} from '@forgeax/editor-core';

// ── Entity state (M7 / AC-15: world-SSOT reads replacing doc.entities) ──
export {
  entHandle,
  entLegacyId,
  entExists,
  entIds,
  entHandles,
  entName,
  entParent,
  entAlive,
  entComponent,
  entComponents,
  entIsDeadWorld,
} from '@forgeax/editor-core';

// ── Context menu service ──
export { ContextMenuHost, showContextMenu } from '@forgeax/editor-core';
export type { MenuItemDef } from '@forgeax/editor-core';

// ── Dock bridge helpers ──
export { focusPanel, openSourcePanel } from '@forgeax/editor-core';

// ── Host-injected game path resolver (layout decoupling) ──
export {
  setPathResolver,
  resolveGamePath,
  hasPathResolver,
  EditorPathResolverError,
} from '@forgeax/editor-core';
export type { PathResolver } from '@forgeax/editor-core';

// ── Viewport clip transport + view intents (preview animation scrubber) ──
export {
  getClipControl,
  getClipControlVersion,
  setClipControl,
  onClipControl,
  useClipControl,
  onViewRequest,
  requestView,
} from '@forgeax/editor-core';
export type { ClipControl, ViewCmd } from '@forgeax/editor-core';