// @forgeax/editor-core — pure logic layer (no UI/React)
//
// Re-exports:
//   Scene types (EntityId, EntityNode, EditSession, SceneAsset, EntitySource)
//   Scene pack (sessionToPack, packToSession, isScenePack, CUBE_GUID, SPHERE_GUID, CYLINDER_GUID)
//   Instantiate (instantiateScene, buildNativeScene, etc.)
//   glTF runtime (loadGltfRuntime, LoadedGltf, etc.)
//   EditorCommand & types
//   EditorBus & bus types
//   Command session (createEditSession, applyCommand, etc.)
//   Component schema (listComponentSchemas, getComponentSchema, etc.)
//   Sync channel (EditorRole, SyncPanelId, EditorSnapshot, EditorSyncMsg, etc.)
//   Anim (Clip, Track, Interp, etc.)
//   Assets (PackAsset, RawAsset, loadGameAssets, etc.)
//   Matgraph (MatGraph, etc.)
//   Presets (ENTITY_PRESETS, getPreset, buildPresetComponents, etc.)

// ── Scene types (SSOT definitions) ──
export type {
  EntityId,
  EntitySource,
  EntityNode,
  EditSession,
  SceneAsset,
} from './types';

export type { EditorCommand, CommandError, ApplyResult } from './types';

// ── Scene pack ──
export {
  sessionToPack,
  packToSession,
  isScenePack,
  stableGuid,
  CUBE_GUID,
  SPHERE_GUID,
  CYLINDER_GUID,
} from './scene-pack';
export type { ScenePack } from './scene-pack';

// ── Instantiate ──
export {
  instantiateScene,
  buildNativeScene,
  instantiateNative,
  sceneEntities,
  instantiateSceneEntities,
  makeSceneCaches,
  SCENE_COMPONENT_TOKENS,
  hexToRgba,
} from './instantiate';
export type {
  WorldLike,
  AssetsLike,
  InstantiateCtx,
  InstantiateResult,
  NativeSceneResult,
  NativeInstance,
  SceneEntity,
  SceneCaches,
  SceneEntitiesResult,
} from './instantiate';

// ── glTF runtime ──
export {
  loadGltfRuntime,
  getLoadedGltf,
  isGltfLoaded,
  _clearGltfCache,
} from './gltf-runtime';
export type { LoadedGltf, LoadedGltfNode } from './gltf-runtime';

// ── Bus ──
export { EditorBus } from './bus';
export type {
  BusListener,
  DispatchResult,
  CommandOrigin,
  HistoryStep,
} from './bus';

// ── Edit session (authoring working state) ──
export { createEditSession, applyCommand, childrenOf, isSelfOrDescendant } from './document';
export { makeEditSession, projectSessionAsset } from './edit-session';

// ── Hot-reload two-tier decision (D-8; consumed by edit-runtime orchestrator) ──
export { schemaFingerprint, decideReloadTier } from './hot-reload';
export type { ReloadTier, SchemaSource } from './hot-reload';

// ── Schema ──
export {
  listComponentSchemas,
  getComponentSchema,
  defaultComponentData,
  clampToField,
  fieldSchema,
  fieldVisible,
  defaultFieldValue,
} from './schema';
export type {
  FieldSchema,
  ComponentSchema,
  FieldType,
} from './schema';

// ── Sync channel ──
export {
  getPopoutPanel,
  getEditorRole,
  openSyncChannel,
} from './sync-channel';
export type {
  EditorRole,
  SyncPanelId,
  EditorSnapshot,
  EditorSyncMsg,
  PopoutGeom,
  AssetChatRef,
} from './sync-channel';

// ── Anim ──
export {
  emptyClip,
  sampleClip,
  setKey,
  removeKey,
} from './anim';
export type { Clip, Track, Interp } from './anim';

// ── Assets ──
export {
  loadGameAssets,
  loadMetaAssets,
  loadRawAssets,
  materialSwatch,
  makeMaterialResolver,
  makeMeshResolver,
  extractPackDirs,
} from './assets';
export type { PackAsset, RawAsset } from './assets';

// ── Drag-to-scene (Content Browser → viewport spawn) ──
export { buildSpawnEntityFromDragRef } from './drag-asset-spawn';
export type { DragAssetRef, SpawnRefEntity } from './drag-asset-spawn';

// ── Imported mesh → original per-submesh materials (drag / Add to Scene) ──
export { resolveMeshOriginalMaterials, _clearMeshMaterialCache } from './mesh-original-materials';
export type { MeshMaterialResolveDeps, MeshAssetRef } from './mesh-original-materials';

// ── glTF import cook (frontend SSOT reuse — engine toAssetPack) ──
export { cookGltfMeta } from './gltf-cook';
export type { GltfCookResult } from './gltf-cook';

// ── Pack CRUD (M2) ──
export {
  generateAssetGuid,
  addAssetToPack,
  removeAssetFromPack,
  renameAssetInPack,
  duplicateAssetInPack,
  moveAsset,
  deleteAsset,
  createPack,
  createDirectory,
} from './pack-ops';

// ── Matgraph ──
export {
  evaluate,
  connect,
  disconnect,
  setParam,
  moveNode,
  removeNode,
  addNode,
  defaultGraph,
  resetGraphIds,
  hasPath,
  pinType,
  rgbToHex,
  hexToRgb,
  KINDS,
} from './matgraph';
export type {
  MatGraph,
  GraphNode,
  Edge,
  NodeKind,
  PinType,
  RGB,
  Value,
  MaterialResult,
} from './matgraph';

// ── Presets ──
export {
  ENTITY_PRESETS,
  getPreset,
  buildPresetComponents,
} from './presets';

// ── Scene types (extended, for games) ──
export type {
  TransformData,
  MeshData,
  MeshKind,
  MaterialData,
  LightData,
  LightType,
  ColliderData,
  ColliderShape,
  Collider,
} from './scene-types';

// ── Manifest (SSOT for panel IDs) ──
export { EDITOR_PANELS } from './manifest';
export type { EditorPanelId } from './manifest';

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
  flushPendingSaveBeacon,
  cancelPendingDiskSave,
  hasPendingDiskSave,
  setAssetSelection,
  getAssetSelection,
  useAssetSelection,
  onAssetSelectionChange,
  publishMeshStats,
  getMeshStats,
  useMeshStats,
} from './store';
export type { SceneFileEntry, PlayConfig, SelectedAsset, MeshStats } from './store';

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

// ── Backend transport seam (R2 DIP) ──
export {
  getApiClient,
  setApiClient,
  createDefaultApiClient,
  type ApiClient,
} from './api-client';

// ── Project authoring (M3) ──
export { openProject, type OpenProjectResult } from './open-project';
export { createFetchReader } from './fetch-reader';

// ── Host-injected game path resolver (layout decoupling) ──
export {
  setPathResolver,
  resolveGamePath,
  hasPathResolver,
  EditorPathResolverError,
} from './path-resolver';
export type { PathResolver } from './path-resolver';

// ── Socket (绑点) editor ──
export {
  SOCKET_DOC_VERSION,
  SOCKET_EULER_ORDER,
  SocketAuxSchema,
  SocketDefSchema,
  SocketDocSchema,
  emptySocketDoc,
  defaultSocket,
  uniqueSocketId,
  normalizeScale,
  targetLenToScale,
  scaleToTargetLen,
  findSocket,
} from './socket';
export type { SocketAux, SocketDef, SocketDoc } from './socket';
export {
  exportSocketJson,
  importSocketJson,
  validateSocketDoc,
  loadSocketDoc,
  saveSocketDoc,
} from './socket-io';
export type { SocketImportResult } from './socket-io';
export {
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
  setClipControlForwarder,
  onClipControl,
  useClipControl,
  onViewRequest,
  requestView,
  setViewRequestForwarder,
} from './socket-store';
export type { SocketCoordSpace, SocketPivot, ClipControl, SocketViewCmd } from './socket-store';
