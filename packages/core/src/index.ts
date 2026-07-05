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
export type { EntityHandle, WorldType } from './scene/scene-types';

export type { EditorCommand, CommandError, ApplyResult } from './types';

// ── Scene pack ──
export {
  isScenePack,
  stableGuid,
  CUBE_GUID,
  SPHERE_GUID,
} from './scene/scene-pack';
export type { ScenePack } from './scene/scene-pack';

// ── Bus ──
export { EditorBus } from './io/bus';
export type {
  BusListener,
  DispatchResult,
  CommandOrigin,
  HistoryStep,
} from './io/bus';

// ── Edit session (authoring working state) ──
// M7 / AC-15: makeEditSession/projectSessionAsset/cloneEditSession deleted
// (they served the EntityNode/doc.entities dual-write mirror).
export { createEditSession, applyCommand, childrenOf, isSelfOrDescendant } from './session/document';

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
} from './store/entity-state';

// ── Hot-reload two-tier decision (D-8; consumed by edit-runtime orchestrator) ──
export { schemaFingerprint, decideReloadTier } from './util/hot-reload';
export type { ReloadTier, SchemaSource } from './util/hot-reload';

// ── Module discoverer (feat-20260630-viewport M2 / w9: edit-runtime wires the
// game systems into the single edit world through this; the only production
// system-registration path) ──
export { discoverModules } from './assets/discoverer';
export type { DiscoveredModule, DiscoverResult } from './assets/discoverer';

// ── Schema ──
export {
  listComponentSchemas,
  getComponentSchema,
  defaultComponentData,
  clampToField,
  fieldSchema,
  fieldVisible,
  defaultFieldValue,
} from './scene/schema';
export type {
  FieldSchema,
  ComponentSchema,
  FieldType,
} from './scene/schema';

// ── Euler↔quat conversion (SSOT, XYZ order, AGENTS.md #6) ──
export { quatToEuler, eulerToQuat } from './util/euler-quat';

// ── Hex↔float color conversion (M6, AC-19 Material panel) ──
export { hexToFloat, floatToHex } from './util/color-utils';

// ── Cross-panel types ──
export type { AssetChatRef, MeshStatsWire } from './io/cross-panel-types';

// ── Assets ──
export {
  loadRawAssets,
  materialSwatch,
  makeMaterialResolver,
  makeMeshResolver,
  extractPackDirs,
} from './assets/assets';
export type { PackAsset, RawAsset } from './assets/assets';

// ── Drag-to-scene (Content Browser → viewport spawn) ──
export { buildSpawnEntityFromDragRef } from './assets/drag-asset-spawn';
export type { DragAssetRef, SpawnRefEntity } from './assets/drag-asset-spawn';
export { spawnAssetRefToScene, spawnAssetRefToScene as spawnAssetToScene, requestAddAssetToScene } from './scene/spawn-asset-ref';

// ── Imported mesh → original per-submesh materials (drag / Add to Scene) ──
export { resolveMeshOriginalMaterials, _clearMeshMaterialCache } from './scene/mesh-original-materials';
export type { MeshMaterialResolveDeps, MeshAssetRef } from './scene/mesh-original-materials';

// ── glTF import cook (frontend SSOT reuse — engine toAssetPack) ──
export { cookGltfMeta } from './assets/gltf-cook';
export { cookFbxMeta, type FbxCookResult } from './assets/fbx-cook';
export type { GltfCookResult } from './assets/gltf-cook';

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
} from './session/pack-ops';

// ── Scene types (extended, for games) ──
export {
  ENTITY_PRESETS,
  getPreset,
  buildPresetComponents,
} from './scene/presets';

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
  instantiateSceneRefUnderWorld,
  notifyDocChanged,
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
} from './store/store';
export type { SceneFileEntry, PlayConfig, SelectedAsset, MeshStats } from './store/store';

// ── Entity operations ──
export {
  deleteEntityCascade,
  deleteManyCascade,
  duplicateEntity,
  groupSelected,
  ungroupEntity,
  reparentEntity,
} from './session/ops';

// ── Context menu service ──
export { ContextMenuHost, showContextMenu } from './ui/context-menu-service';
export type { MenuItemDef } from './ui/context-menu-service';

// ── Dock bridge helpers ──
export { focusPanel, openSourcePanel } from './io/dock-bridge';

// ── Backend transport seam (R2 DIP) ──
export {
  getApiClient,
  setApiClient,
  createDefaultApiClient,
  type ApiClient,
} from './io/api-client';

// ── Project authoring (M3) ──
export { openProject, type OpenProjectResult } from './session/open-project';
export { createFetchReader } from './io/fetch-reader';

// ── Host-injected game path resolver (layout decoupling) ──
export {
  setPathResolver,
  resolveGamePath,
  hasPathResolver,
  EditorPathResolverError,
} from './util/path-resolver';
export type { PathResolver } from './util/path-resolver';

// ── EditMode resource injection (▶/■ Simulate, feat-20260630-viewport w11) ──
export { injectEditMode, EDIT_MODE_KEY } from './session/edit-mode';
export type { EditModeState } from './session/edit-mode';
// ── Run conditions (notEditing gate + and combinator, feat-20260630 w10) ──
// Barrel-symmetric with injectEditMode: consumers wiring game systems need the
// same gate the discoverer uses (verify V-3 affordances finding).
export { notEditing, and } from './session/run-conditions';
export type { RunCondition } from './session/run-conditions';
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
} from './io/clip-control';
export type { ClipControl, ViewCmd } from './io/clip-control';

// UI 语义操作层(P1-12):面板 action 登记 → interface host 的 ActionRegistry。
export { registerPanelAction } from './io/action-bridge';
export type { PanelActionDef, PanelActionResult } from './io/action-bridge';
