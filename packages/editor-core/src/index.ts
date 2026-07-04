// @forgeax/editor-core — pure logic layer (no UI/React)
//
// M4: instantiate.ts + gltf-runtime.ts projection layer deleted (AC-12).
// M6: anim.ts + matgraph.ts deleted (AC-12/13).
//
// Re-exports:
//   Scene types (EntityId, EntityNode, EditSession, SceneAsset, EntitySource)
//   Scene pack (isScenePack, stableGuid, CUBE_GUID, SPHERE_GUID)
//   EditorCommand & types
//   EditorBus & bus types
//   Command session (createEditSession, applyCommand, etc.)
//   Component schema (listComponentSchemas, getComponentSchema, etc.)
//   Sync channel (EditorRole, SyncPanelId, EditorSnapshot, EditorSyncMsg, etc.)
//   Assets (PackAsset, RawAsset, loadGameAssets, etc.)
//   Presets (ENTITY_PRESETS, getPreset, buildPresetComponents, etc.)

// ── Scene types (SSOT definitions) ──
// M7 / AC-15: EntityNode deleted (world is the SSOT for entity state).
export type {
  EntityId,
  EntitySource,
  EditSession,
  SceneAsset,
} from './types';

// EntityHandle / WorldType: thin re-exports of the engine's real types via
// scene-types (EntityHandle straight from @forgeax/engine-ecs, WorldType = the
// `World` class type). Kept re-exported here so consumers can import them from
// the editor-core barrel.
export type { EntityHandle, WorldType } from './scene-types';

export type { EditorCommand, CommandError, ApplyResult } from './types';

// ── Scene pack ──
export {
  isScenePack,
  stableGuid,
  CUBE_GUID,
  SPHERE_GUID,
} from './scene-pack';
export type { ScenePack } from './scene-pack';

// ── Bus ──
export { EditorBus } from './bus';
export type {
  BusListener,
  DispatchResult,
  CommandOrigin,
  HistoryStep,
} from './bus';

// ── Edit session (authoring working state) ──
// M7 / AC-15: makeEditSession/projectSessionAsset/cloneEditSession deleted
// (they served the EntityNode/doc.entities dual-write mirror).
export { createEditSession, applyCommand, childrenOf, isSelfOrDescendant } from './document';

// ── Entity state (M7 / AC-15: world-SSOT reads replacing doc.entities) ──
// Panels/consumers read entity name/parent/components/handle/existence through
// these helpers (world.get on main, popout cache on popout windows).
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
} from './entity-state';

// ── Hot-reload two-tier decision (D-8; consumed by edit-runtime orchestrator) ──
export { schemaFingerprint, decideReloadTier } from './hot-reload';
export type { ReloadTier, SchemaSource } from './hot-reload';

// ── Module discoverer (feat-20260630-viewport M2 / w9: edit-runtime wires the
// game systems into the single edit world through this; the only production
// system-registration path) ──
export { discoverModules } from './discoverer';
export type { DiscoveredModule, DiscoverResult } from './discoverer';

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

// ── Euler↔quat conversion (SSOT, XYZ order, AGENTS.md #6) ──
export { quatToEuler, eulerToQuat } from './euler-quat';

// ── Hex↔float color conversion (M6, AC-19 Material panel) ──
export { hexToFloat, floatToHex } from './color-utils';

// ── Cross-panel types ──
export type { AssetChatRef, MeshStatsWire } from './cross-panel-types';

// ── Assets ──
export {
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
export { spawnAssetRefToScene, spawnAssetRefToScene as spawnAssetToScene } from './spawn-asset-ref';

// ── Imported mesh → original per-submesh materials (drag / Add to Scene) ──
export { resolveMeshOriginalMaterials, _clearMeshMaterialCache } from './mesh-original-materials';
export type { MeshMaterialResolveDeps, MeshAssetRef } from './mesh-original-materials';

// ── glTF import cook (frontend SSOT reuse — engine toAssetPack) ──
export { cookGltfMeta } from './gltf-cook';
export { cookFbxMeta, type FbxCookResult } from './fbx-cook';
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

// ── Scene types (extended, for games) ──
export {
  ENTITY_PRESETS,
  getPreset,
  buildPresetComponents,
} from './presets';

// M7 / AC-15: authored component types (TransformData/MeshData/MaterialData/
// LightData/ColliderData/etc.) deleted — the engine World is the SSOT for all
// entity component state; no parallel authored type mirror remains.

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
  requestFrame,
  requestRefComponent,
  requestRefAsset,
  requestRefEntity,
  requestAddAssetsToChat,
  requestAddAssetToScene,
  useDocVersion,
  useGizmoMode,
  useSelection,
  useSelectionList,
  useHoverEntity,
  useFieldPreview,
  loadDocFromStorage,
  loadDocFromDisk,
  getLoadedSceneRoot,
  rebindLoadedScene,
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

// ── EditMode resource injection (▶/■ Simulate, feat-20260630-viewport w11) ──
export { injectEditMode, EDIT_MODE_KEY } from './edit-mode';
export type { EditModeState } from './edit-mode';
// ── Run conditions (notEditing gate + and combinator, feat-20260630 w10) ──
// Barrel-symmetric with injectEditMode: consumers wiring game systems need the
// same gate the discoverer uses (verify V-3 affordances finding).
export { notEditing, and } from './run-conditions';
export type { RunCondition } from './run-conditions';
// ── EditorHidden (editor-only component, plan-strategy §2 D-7 / AC-04/05) ──
export { EditorHidden } from './components/EditorHidden';

// ── Viewport clip transport + view intents (preview animation scrubber) ──
export {
  getClipControl,
  getClipControlVersion,
  setClipControl,
  setClipControlForwarder,
  onClipControl,
  useClipControl,
  onViewRequest,
  requestView,
  setViewRequestForwarder,
} from './clip-control';
export type { ClipControl, ViewCmd } from './clip-control';

// UI 语义操作层(P1-12):面板 action 登记 → interface host 的 ActionRegistry。
export { registerPanelAction } from './actionBridge';
export type { PanelActionDef, PanelActionResult } from './actionBridge';
