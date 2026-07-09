// @forgeax/editor-core — pure logic layer (no UI/React)
//
// M4: instantiate.ts + gltf-runtime.ts projection layer deleted (AC-12).
// M6: anim.ts + matgraph.ts deleted (AC-12/13).
//
// Re-exports:
//   Scene types (EntityId, EntityNode, EditSession, SceneAsset, EntitySource)
//   Scene pack (isScenePack, stableGuid, CUBE_GUID, SPHERE_GUID)
//   EditorOp & types
//   EditGateway & gateway types
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

export type { EditorOp, CommandError, ApplyResult } from './types';
export type { EditorOpLifecycle } from './types';

// ── Scene pack ──
// M1: validatePackShell + PackShellValidationError exported for AI-user discovery
// (charter F1: barrel single-entry discoverability).
export {
  isScenePack,
  stableGuid,
  CUBE_GUID,
  SPHERE_GUID,
  validatePackShell,
  PackShellValidationError,
} from './scene/scene-pack';
export type { ScenePack, PackFile, ValidatePackShellResult } from './scene/scene-pack';

// ── Gateway ──
export { EditGateway } from './io/gateway';
export type {
  BusListener,
  DispatchResult,
  CommandOrigin,
  HistoryStep,
  OpHandle,
  ApplierCtx,
} from './io/gateway';
// M3 t16 (plan-strategy §2 D-2 / research F-3): the EngineFacade TYPE is the
// controlled-write-proxy contract edit-runtime types its view-scaffold signatures
// against (ViewportDeps.engine, preview-skin, drag-spawn). Type-only export — no
// runtime symbol added to the barrel (index.ts fan-in budget unaffected, D-8).
export type { EngineFacade } from './io/engine-facade';

// ── M5 eval channel (plan-strategy §2 D-4, D-8) ──
// createEvalChannel is the single runtime export for the dev-accessible AI eval
// channel. Consumed by edit-runtime to mount on globalThis.__forgeaxEval (Q-5).
// EvalChannel type is type-only: edit-runtime types its globalThis hook against it.
export { createEvalChannel } from './io/channel';
export type { EvalChannel, EvaluateResult } from './io/channel';

// SpanNode is the trace-tree node type returned by gateway.trace.recent()/.last()
// (D-3 / AC-09). Type-only export so an AI consumer writing typed code against the
// trace read API can name the return shape. verify F-V1.
export type { SpanNode } from './io/trace';

// ── Catalog (M4 listOps / argsSchema / OpDescriptor) ──
export type { OpDescriptor, ArgsSchema } from './io/catalog';

// ── D-11 downstream session-applier seam ──
// edit-runtime registers the real play/stop applier at boot through this seam
// (injection direction edit-runtime→core, same shape as the ApiClient backend
// seam — does not violate the DAG). Exposed on the barrel so the DAG-downstream
// package can reach it (it may only import the published surface).
export { registerSessionApplier } from './io/appliers';
export type { SessionApplier, SessionApplierMeta } from './io/appliers';

// ── Edit session (authoring working state) ──
// M7 / AC-15: makeEditSession/projectSessionAsset/cloneEditSession deleted
// (they served the EntityNode/doc.entities dual-write mirror).
export { createEditSession, applyCommand, childrenOf, isSelfOrDescendant } from './session/document';

// ── Entity state (M3 / I1: activeWorld read face, handle IS identity) ──
// Panels/consumers read entity name/parent/components/existence through these
// helpers, each taking a World (the caller passes gateway.activeWorld) + an
// EntityHandle. The legacy-id<->handle mapping ops (entHandle/entLegacyId/entMap/
// entUnmap/entNextId/entIds/entHandles/entRootHandles) are deleted (AC-01);
// enumeration is worldEntityHandles/worldRootHandles (Name query walk).
export {
  entExists,
  entName,
  entParent,
  entComponent,
  entComponents,
  worldEntityHandles,
  worldRootHandles,
} from './store/entity-state';
export type { StaleEntityHandleError, ComponentAbsentError, StaleHandleResult, EditRejectedInPlayError } from './store/entity-state';

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

// ── Panel bridge (typed event bus, replaces legacy postMessage self-posting) ──
export { panelBridge, editorBus } from './io/panel-bridge';
export type { PanelBridgeEvents, EditorBusEvents, EditorRefPayload } from './io/panel-bridge';
export { installEditorBusCompat } from './io/editor-bus-compat';

// ── Panel ops (session domain: focusPanel, openSource) ──
// Side-effect import: registers appliers into sessionAppliers at module eval.
import './store/panel-ops';

// ── CB nav (session domain: setCBPath, cbGoBack, cbGoForward) ──
// Side-effect import: registers cb-nav appliers into sessionAppliers at module eval.
// Boot timing: after gateway singleton creation, before CB first render (§C6, §F-9).
import './store/cb-nav';

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
export { buildSpawnEntityFromDragRef, recoverMeshOriginalMaterialGuids } from './assets/drag-asset-spawn';
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

// ── Store (gateway singleton — gateway, selection, scene persistence) ──
// M3 (AC-08, D-6): the 11 store OP SETTERS are SEALED — no longer on the barrel.
// Every state mutation is a gateway op now (gateway.dispatch / begin…commit); the
// sealed names (setSelection/setSelectionMany/toggleSelection/setGizmoMode/
// setHoverEntity/setFieldPreview/setAssetSelection/saveDocToDisk/setSceneId/
// requestFrame/requestRename) and the `dispatch` wrapper were removed from the
// published surface. Getters/hooks/subscribe/async-scene ops stay public
// (consumers READ state and await async loads). D-5 exemptions (ref-request /
// mesh-stats / assets-changed / disk-watch) and doc-version/gateway infra are unchanged.
export {
  gateway,
  getSceneId,
  getSelection,
  getSelectionList,
  getGizmoMode,
  replaceDoc,
  onSelectionChange,
  onRenameRequest,
  onGizmoModeChange,
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

// ── Resize primitive (shared splitter: drag handle + persisted size hook) ──
export { ResizeHandle, useLocalSize } from './ui/resize-handle';

// ── Dock bridge helpers ──
export { focusPanel, openSourcePanel } from './io/dock-bridge';

// ── Backend transport (M4 same-origin /api helper) ──
// The former DIP seam (get/set/create-default accessors + ApiClient interface)
// was a dead abstraction that never switched; M4 collapsed it to one same-origin
// function (AC-06). Boot-path timeout calls use fetchWithTimeout (net.ts).
export { apiFetch } from './io/api-client';

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

// ── CB nav read interface (feat-20260708-cb-nav-session-op-convergence M1) ──
// Public read surface for CB navigation state. CB package imports these from
// @forgeax/editor-core (no deep import into store/cb-nav internals — §C4).
// Dispatch mutations via gateway.dispatch({ kind: 'setCBPath'/'cbGoBack'/'cbGoForward' }).
export { useCBNav, getCBPath, getCBNavState, onCBNavChange } from './store/cb-nav';
