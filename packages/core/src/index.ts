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

export type { EditorOp, CommandError, ApplyResult, CreatableAssetKind, PlayDirtyPolicy } from './types';
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

// ── Product-neutral public slices ──
export * from './public/gateway';
export * from './public/runtime';
export * from './public/assets';
// Keep type names explicit in the root source surface as well as through the
// public slices. This makes consumer-driven barrel checks inspect the same
// contract that TypeScript resolves through export-star re-exports.
export type {
  CommandOrigin,
  DispatchResult,
  EngineFacade,
  OpDescriptor,
  OpHandle,
  OperationRun,
  SessionApplier,
} from './public/gateway';
export type { GameplayIdentity } from './public/runtime';
export type {
  AssetBrowserCatalogRoot,
  AssetBrowserRegistry,
  AssetBrowserSnapshot,
  AssetMutationOperation,
  AssetMutationRequest,
  AssetPreflightResult,
  AssetWorkspaceSnapshot,
  DragAssetRef,
  ImportFileResult,
  ImportFailure,
  ImportFailureCode,
  ImportProgressEvent,
  ImportProgressStage,
  ImportSubAsset,
  PackAsset,
} from './public/assets';

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

// Runtime UI diagnostics are the typed read-only Gateway contract. The graph
// remains internal; consumers receive only schema-valid status and counters.
export {
  createRuntimeUiOperations,
  createRuntimeUiGraph,
  getActiveRuntimeUiGraph,
  parseRuntimeUiDiagnostics,
  RUNTIME_UI_OPERATION_MANIFEST,
} from './io/runtime-ui-diagnostics';
export { default as RUNTIME_UI_DIAGNOSTICS_SCHEMA } from './io/runtime-ui-diagnostics.schema.json';
export type {
  RuntimeUiCapabilities,
  RuntimeUiDiagnostics,
  RuntimeUiError,
  RuntimeUiOperations,
  RuntimeUiProvenance,
  RuntimeUiStats,
  RuntimeUiGraph,
} from './io/runtime-ui-diagnostics';
export { createInspectorFieldSelector } from './store/live-world-field-selectors';
export type {
  InspectorFieldAvailable,
  InspectorFieldSelector,
  InspectorFieldSelectorOptions,
  InspectorFieldShape,
  InspectorFieldSnapshot,
  InspectorFieldSubscription,
  InspectorFieldUnavailable,
} from './store/live-world-field-selectors';

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
  entComponentsPresent,
  worldComponentNames,
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
  isComponentHidden,
} from './scene/schema';
export type {
  FieldSchema,
  ComponentSchema,
  FieldType,
} from './scene/schema';
// Editor-owned component metadata overlay (SSOT), injected into
// `Component.meta.editor` post-registration; the engine stays agnostic.
export {
  applyEditorComponentMeta,
  editorMetaOf,
  EDITOR_COMPONENT_META,
} from './scene/editor-component-meta';
export type { EditorComponentMeta } from './scene/editor-component-meta';

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

// ── Material ops — updateMaterialParams document applier registration ──
// Side-effect import: registers the document applier into the gateway table.
import './session/material-ops';

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
  getGizmoSpace,
  replaceDoc,
  onSelectionChange,
  onRenameRequest,
  onGizmoModeChange,
  onGizmoSpaceChange,
  requestRefComponent,
  requestRefAsset,
  requestRefEntity,
  requestAddAssetsToChat,
  useDocVersion,
  useGizmoMode,
  useGizmoSpace,
  useSelection,
  useSelectionList,
  useIsSelected,
  useHoverEntity,
  useIsHoverEntity,
  useFieldPreview,
  loadDocFromStorage,
  loadDocFromDisk,
  getLoadedSceneEntities,
  initDiskWatch,
  initSceneList,
  getSceneFile,
  getActiveScenePackPath,
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
  subscribeDocVersion,
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

// Folder/file selection (session domain): setFolderSelection op + reactive read.
export {
  getFolderSelectionList,
  getPathSelectionList,
  onFolderSelectionChange,
  useFolderSelectionSet,
  clearFolderSelection,
} from './store/folder-selection';
export type { PathSelectionItem } from './store/folder-selection';

// AssetsChangedHint — hint type for broadcastAssetsChanged optimization.
export type { AssetsChangedHint } from './store/assets-changed';

// broadcastAssetsError — companion to broadcastAssetsChanged: fire-and-forget
// asset IO that failed AFTER the applier returned ok. Panels subscribe via
// panelBridge.on('assetsError', …) and toast; the applier remains SSOT for
// state mutation (north-star §9). See dev-plan §5 step 3.
export { broadcastAssetsError } from './store/assets-error-bus';
export type { AssetsErrorPayload } from './store/assets-error-bus';
export type { SceneFileEntry, PlayConfig, SelectedAsset, MeshStats, GizmoSpace } from './store/store';

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
  scanAssetsIntegrity,
  repairAssets,
} from './scan/index';
export type {
  IntegrityScanResult,
  NeedsMetaEntry,
  OrphanedSidecarEntry,
  RepairReport,
  RepairEntry,
} from './scan/index';
