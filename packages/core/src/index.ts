// @forgeax/editor-core — pure logic layer (no UI/React).
//
// This barrel is the single published surface. Consumers import everything from
// here; the internal file layout may change freely as long as this file stays
// stable. The barrel is intentionally zero-side-effect except for the four
// `import './store/...'` lines below, which register session appliers at eval
// time (see comments inline).

// ── Scene types (SSOT definitions) ──
export type {
  EntityId,
  EntitySource,
  EditSession,
  SceneAsset,
} from './types';

// EntityHandle / WorldType are thin re-exports of engine types so consumers can
// reach them from the editor-core barrel.
export type { EntityHandle, WorldType } from './scene/scene-types';

export type { EditorOp, CommandError, ApplyResult, CreatableAssetKind } from './types';
export type { EditorOpLifecycle } from './types';

// ── Scene pack ──
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
  AssetSummary,
  AssetSummaryResult,
  CommandOrigin,
  HistoryStep,
  OpHandle,
  ApplierCtx,
} from './io/gateway';
export type { CollectSceneAssetResult } from './io/scene-asset-collect';
// EngineFacade is the controlled-write-proxy the view scaffold types itself
// against (ViewportDeps.engine, preview-skin, drag-spawn). Type-only.
export type { EngineFacade } from './io/engine-facade';
// createEngineFacade is used by world-manager to mint a DEDICATED EngineFacade
// bound to editorWorld — the gateway's engineFacade() binds to sceneWorld
// (doc.world) and must not be repurposed. Raw `new EngineFacade` stays inside
// engine-facade.ts so the lint-unique-mutator single-write-gate invariant holds.
export { createEngineFacade } from './io/engine-facade';

// ── Eval channel (dev-accessible AI eval) ──
// Consumed by edit-runtime to mount on globalThis.__forgeaxEval.
export { createEvalChannel } from './io/channel';
export type { EvalChannel, EvaluateResult } from './io/channel';
export type {
  GameActionDescriptor,
  GameActionRegistration,
  GameProjectionRegistrar,
  GameProjectionResult,
  GameProjectionValue,
  GameReadDescriptor,
  GameReadRegistration,
} from './io/game-projection';

// SpanNode is the trace-tree node type returned by gateway.trace.recent()/.last().
export type { SpanNode } from './io/trace';

// ── Catalog (listOps / argsSchema / OpDescriptor) ──
export type { OpDescriptor, ArgsSchema } from './io/catalog';

// ── Downstream session-applier seam ──
// edit-runtime registers the real play/stop applier at boot through this seam
// (injection direction edit-runtime→core; does not violate the DAG).
export { registerSessionApplier } from './io/appliers';
export type { SessionApplier, SessionApplierMeta } from './io/appliers';

// ── Edit session (authoring working state) ──
export { createEditSession, applyCommand, childrenOf, isSelfOrDescendant } from './session/document';

// ── Entity state (activeWorld read face, handle IS identity) ──
// Panels/consumers read entity name/parent/components/existence through these
// helpers; each takes a World (typically gateway.activeWorld) + an EntityHandle.
// Enumeration is worldEntityHandles/worldRootHandles (Name query walk).
export {
  entExists,
  entName,
  entParent,
  entComponent,
  entComponents,
  worldEntityHandles,
  worldRootHandles,
  registerActiveReadBinding,
  getActiveReadBinding,
} from './store/entity-state';
export type { StaleEntityHandleError, ComponentAbsentError, StaleHandleResult, EditRejectedInPlayError, HandleCheckOpts } from './store/entity-state';

// ── Handle-pair (world-bound handle + three-layer validation) ──
// The world-manager layer holds HandlePairs (worldRef + epoch + entity) instead
// of bare EntityHandles, and validates them through validateHandlePair before
// any read/write — the defence against cross-world reads.
export { validateHandlePair } from './store/handle-pair';
export type {
  HandlePair,
  HandlePairBinding,
  HandlePairResult,
  HandlePairStaleReason,
  WorldMismatchError,
  HandlePairStaleError,
} from './store/handle-pair';

// world-manager selection door: mints world-bound pairs, reads them, and
// batch-invalidates on reload.
export {
  getSelectionPair,
  getSelectionPairs,
  registerSelectionBindingProvider,
  revalidateSelection,
} from './store/selection';

// ── Hot-reload (two-tier decision, consumed by edit-runtime orchestrator) ──
export { schemaFingerprint, decideReloadTier } from './util/hot-reload';
export type { ReloadTier, SchemaSource } from './util/hot-reload';

// ── Module discoverer (game systems into the single edit world) ──
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

// ── Hex↔float color conversion (used by the Material inspector) ──
export { hexToFloat, floatToHex } from './util/color-utils';

// ── Cross-panel types ──
export type { AssetChatRef, MeshStatsWire } from './io/cross-panel-types';

// ── Panel bridge (typed in-process event bus) ──
export { panelBridge } from './io/panel-bridge';
export type { PanelBridgeEvents, EditorRefPayload } from './io/panel-bridge';
export { installInterfaceBridge } from './io/interface-bridge';
export type { InterfaceBridgeHandlers } from './io/interface-bridge';

// ── CB nav / folder selection (session-domain appliers) ──
// Side-effect imports: register cb-nav + folder-selection appliers into
// sessionAppliers at module eval. Boot timing: after gateway singleton creation,
// before Content Browser first render.
import './store/cb-nav';
import './store/folder-selection';
// deleteSourceFile session applier (M1).
import './session/source-file-ops';

// ── Assets ──
export {
  loadRawAssets,
  materialSwatch,
  extractPackDirs,
} from './assets/assets';
export type { PackAsset, RawAsset } from './assets/assets';

// ── Drag-to-scene (Content Browser → viewport spawn) ──
export { buildSpawnEntityFromDragRef, recoverMeshOriginalMaterialGuids } from './assets/drag-asset-spawn';
export type { DragAssetRef, SpawnRefEntity } from './assets/drag-asset-spawn';
export { spawnAssetRefToScene, requestAddAssetToScene } from './scene/spawn-asset-ref';

// ── Imported mesh → original per-submesh materials (drag / Add to Scene) ──
export { resolveMeshOriginalMaterials, _clearMeshMaterialCache } from './scene/mesh-original-materials';
export type { MeshMaterialResolveDeps, MeshAssetRef } from './scene/mesh-original-materials';

// ── glTF import cook (frontend SSOT reuse — engine toAssetPack) ──
export { cookGltfMeta } from './assets/gltf-cook';
export { cookFbxMeta, type FbxCookResult } from './assets/fbx-cook';
export type { GltfCookResult } from './assets/gltf-cook';
export { createAssetBrowserReadModel } from './assets/asset-browser-read-model';
export type {
  AssetBrowserAsset,
  AssetBrowserCatalogRoot,
  AssetBrowserDiagnostic,
  AssetBrowserDirectory,
  AssetBrowserFile,
  AssetBrowserReadModel,
  AssetBrowserRegistry,
  AssetBrowserRegistryEntry,
  AssetBrowserSnapshot,
  AssetBrowserTreeNode,
  AssetSourcePhase,
  AssetSourceState,
  CreateAssetBrowserReadModelDeps,
} from './assets/asset-browser-read-model';

// ── Pack CRUD — applier-gated ──
// Direct pack writes (createPack / addAssetToPack / etc.) are NOT exported;
// go through the ctx.assetIO seam instead.
export { assetIO, AssetIOFacade } from './io/asset-io-facade';
export type { SourceFileDeleteResult } from './io/asset-io-facade';
export type { SourceFileDeleteStatus } from './session/source-file-delete-status';
export {
  generateAssetGuid,
  renameAssetInPack,
  deleteAsset,
  createDirectory,
  deleteDirectory,
} from './session/pack-ops';

// ── Asset import — executor + importAsset session op ──
// Importing this module also runs its side-effect: registering the importAsset
// session applier into the one-door table.
export { executeAssetImport } from './session/import-ops';
export type { AssetImportSpec, ImportFileResult, ImportFileStatus } from './session/import-ops';

// ── Scene presets (blank-create templates) ──
export {
  ENTITY_PRESETS,
  getPreset,
  buildPresetComponents,
} from './scene/presets';

// ── Manifest (SSOT for panel IDs) ──
export { EDITOR_PANELS } from './manifest';
export type { EditorPanelId } from './manifest';

// ── Store (gateway singleton — gateway, selection, scene persistence) ──
// The store OP SETTERS (setSelection / setGizmoMode / requestFrame / ...) are NOT
// on this barrel — every state mutation is a gateway.dispatch call. Only
// getters/hooks/subscribes and async scene ops are published here.
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
  getLoadedSceneEntities,
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
  getAssetSelectionList,
  useAssetSelectionList,
  clearAssetSelection,
  onAssetSelectionChange,
  registerAssetSelectAllHandler,
  triggerAssetSelectAll,
  publishMeshStats,
  getMeshStats,
  useMeshStats,
} from './store/store';
// Single-source "who was selected last" Derive — keyboard router + panel
// scope-ring both read this; no second divergent state.
export {
  getLastSelectionDomain,
  useLastSelectionDomain,
  subscribeLastSelectionDomain,
} from './store/last-selection-domain';
export type { SelectionDomain } from './store/last-selection-domain';

// Folder selection (session domain): setFolderSelection op + reactive read.
export {
  getFolderSelectionList,
  onFolderSelectionChange,
  useFolderSelectionSet,
} from './store/folder-selection';

// AssetsChangedHint — hint type for broadcastAssetsChanged optimization.
export type { AssetsChangedHint } from './store/assets-changed';
export type { SceneFileEntry, PlayConfig, SelectedAsset, MeshStats } from './store/store';

// ── Entity operations ──
export {
  deleteEntityCascade,
  deleteManyCascade,
  duplicateEntity,
  groupSelected,
  ungroupEntity,
  reparentEntity,
  reparentMany,
  reparentAt,
} from './session/ops';

// ── Context menu service ──
export { setContextMenuRenderer, showContextMenu } from './ui/context-menu-service';
export type { ContextMenuRenderer, ContextMenuRequest, MenuItemDef } from './ui/context-menu-service';

// ── Resize primitive (shared splitter: drag handle + persisted size hook) ──
export { ResizeHandle, useLocalSize } from './ui/resize-handle';

// ── Host-injected game path resolver (layout decoupling) ──
export {
  setPathResolver,
  resolveGamePath,
  hasPathResolver,
  EditorPathResolverError,
} from './util/path-resolver';
export type { PathResolver } from './util/path-resolver';

// ── Run conditions (`and` combinator for RunCondition-shaped predicates) ──
export { and } from './session/run-conditions';
export type { RunCondition } from './session/run-conditions';
// ── EditorHidden (editor-only marker component) ──
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

// ── CB nav read interface ──
// Public read surface for Content Browser navigation. Dispatch mutations via
// gateway.dispatch({ kind: 'setCBPath' | 'cbGoBack' | 'cbGoForward' }).
export { useCBNav, getCBPath, getCBNavState, onCBNavChange } from './store/cb-nav';

// ── Asset scan helpers ──
// Scan fs/stat/hash/IO runs Node-side (vite-plugin-pack + platform-io).
// Core keeps types, pure functions, and explicit session operations; runtime
// notifications live under assets/. Side-effect import registers scan session
// appliers at module eval time.
import './scan/scan-ops';
export type {
  ScanState,
  DirEntry,
  ScanEntry,
  ScanEntryStatus,
  ScanDiagnostic,
  DiagnosticSeverity,
  ScanDiff,
  DirStat,
  FileStat,
  ImportFormat,
  ImporterKey,
  SubAssetKind,
} from './scan/index';
export {
  createEmptyScanState,
  fullScanDiff,
  diffDirs,
  diffFilesL1,
  diffFilesL2,
  computeContentHash,
  computeContentHashFromBytes,
  xxh64,
  IMPORT_FORMATS,
  getImportFormat,
  isImportable,
  getAllExtensions,
  validateSource,
  validateSourceQuick,
} from './scan/index';
export { installAssetHmrBridge } from './assets/asset-hmr-bridge';
