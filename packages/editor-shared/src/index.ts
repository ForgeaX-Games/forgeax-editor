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

// ── Socket (绑点) editor ──
export {
  SOCKET_DOC_VERSION,
  SOCKET_EULER_ORDER,
  emptySocketDoc,
  defaultSocket,
  uniqueSocketId,
  normalizeScale,
  targetLenToScale,
  scaleToTargetLen,
  findSocket,
  exportSocketJson,
  importSocketJson,
  validateSocketDoc,
  loadSocketDoc,
  saveSocketDoc,
  getSocketDoc,
  setSocketDoc,
  getSocketDocVersion,
  useSocketDocVersion,
  addSocket,
  removeSocket,
  updateSocket,
  setSkeletonId,
  getSelectedSocketId,
  setSelectedSocketId,
  useSelectedSocketId,
  getCoordSpace,
  setCoordSpace,
  useCoordSpace,
  getPivot,
  setPivot,
  usePivot,
  onSocketPreview,
  getClipControl,
  getClipControlVersion,
  setClipControl,
  onClipControl,
  useClipControl,
  onViewRequest,
  requestView,
} from '@forgeax/editor-core';
export type {
  SocketAux,
  SocketDef,
  SocketDoc,
  SocketImportResult,
  SocketCoordSpace,
  SocketPivot,
  ClipControl,
  SocketViewCmd,
} from '@forgeax/editor-core';