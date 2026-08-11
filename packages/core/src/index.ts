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
export { normalizeAnimationPlayerSceneAsset } from './scene/animation-slot-sync';

export type { EditorOp, CommandError, ApplyResult, CreatableAssetKind, PlayDirtyPolicy, SceneSwitchDirtyPolicy } from './types';
export type { EditorOpLifecycle } from './types';
export type {
  CommandErrorContext,
  ErrorCategory,
  ErrorCause,
  ErrorEntityLocator,
  ErrorObjectRefs,
  ErrorOwner,
  ErrorSubjectRef,
} from '@forgeax/editor-product';
export { createEntityObjectRef } from '@forgeax/editor-product';

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
  HistoryDiff,
  OpDescriptor,
  OpHandle,
  OperationRun,
  SessionApplier,
  SessionApplierMeta,
} from './public/gateway';
export type { GameplayIdentity } from './public/runtime';
export type {
  AssetBrowserAsset,
  AssetBrowserCatalogRelation,
  AssetBrowserCatalogRoot,
  AssetBrowserRegistry,
  AssetBrowserRegistryEntry,
  AssetBrowserSnapshot,
  ActiveSceneSourceReference,
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
  SceneActivationDescriptor,
  SourceAuthoringRuntime,
  SourceMutationPreflightInput,
} from './public/assets';
export { queryCompatibleAssetCatalog } from './assets/compatible-asset-catalog';
export type {
  CompatibleAssetCatalogError,
  CompatibleAssetCatalogResult,
  CompatibleAssetCatalogRow,
} from './assets/compatible-asset-catalog';

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
export type { SceneReadModel, SceneReadModelEntry, SceneReadModelReference } from './io/scene-read-model';
export type {
  SceneInstanceMemberReadModel,
  SceneInstanceOverrideReadModel,
  SceneInstanceReadModel,
  SceneInstanceReadResult,
  SceneInstanceSourceReadModel,
} from './io/scene-instance-read-model';
export type { SelectionReadModel } from './io/selection-read-model';
export type {
  ImportedSceneSessionIdentity,
  SceneAuthoringMode,
  SceneAuthoringSaveTarget,
  SceneAuthoringSessionReadModel,
} from './io/scene-authoring-session';

// Diagnostics are a read-only projection of existing trace, scan, asset-bus,
// and OperationRun facts. Console output is intentionally not an input source.
export { createDiagnosticsReadModel, queryDiagnosticsSnapshot, DIAGNOSTICS_DEDUPE, DIAGNOSTICS_RETENTION, DIAGNOSTICS_SCHEMA_VERSION } from './io/diagnostics';
export type {
  CreateDiagnosticsReadModelDeps,
  DiagnosticsAssetSource,
  DiagnosticsDedupe,
  DiagnosticsOperationRunSource,
  DiagnosticsQueryItem,
  DiagnosticsQueryRequest,
  DiagnosticsQueryResult,
  DiagnosticsReadModel,
  DiagnosticsReadModelOptions,
  DiagnosticsRetention,
  DiagnosticsScanSource,
  DiagnosticsSeverity,
  DiagnosticsSource,
  DiagnosticsSnapshot,
  DiagnosticsTraceSource,
  RuntimeDiagnosticFact,
  RuntimeDiagnosticProjectionFact,
  RuntimeDiagnosticsProvider,
} from './io/diagnostics';
export {
  getProjectValidationProvider,
  normalizeProjectValidationResult,
  projectValidationDiagnostics,
  registerProjectValidationProvider,
  PROJECT_VALIDATION_MAX_ISSUES,
  PROJECT_VALIDATION_OPERATION,
  PROJECT_VALIDATION_SCHEMA_VERSION,
} from './io/project-validation';
export type {
  ProjectValidationIssue,
  ProjectValidationOptions,
  ProjectValidationProvider,
  ProjectValidationResult,
  ProjectValidationResultEnvelope,
  ProjectValidationStats,
} from './io/project-validation';
export { createRuntimeReadiness, RUNTIME_READINESS_STATES, runtimeReadinessDiagnostic } from './public/gateway';
export type {
  CreateRuntimeReadinessInput,
  RuntimeReadiness,
  RuntimeReadinessState,
  RuntimeRevision,
} from './public/gateway';
export type { RuntimeReadinessDiagnostic } from './public/gateway';
export {
  bindViewportRuntimeClient,
  cancelViewportRuntimeOperationRun,
  discoverViewportRuntimeCapabilities,
  dispatchViewportRuntimeOperation,
  forwardViewportRuntimeTransportRequest,
  getViewportRuntimeOperationRun,
  getViewportRuntimeClientSnapshot,
  getViewportRuntimeSelectionSnapshot,
  queryViewportRuntimeProjection,
  retryViewportRuntimeOperationRun,
  subscribeViewportRuntimeClient,
  waitViewportRuntimeOperationRun,
} from './io/viewport-runtime-client';
export { dispatchActiveEditorOperation } from './store/active-operation';
export type {
  ViewportRuntimeClientSnapshot,
  ViewportRuntimeClientStatus,
  ViewportRuntimeSelectionSnapshot,
} from './io/viewport-runtime-client';

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
  worldRenderableHandles,
  worldRootHandles,
  registerActiveReadBinding,
  getActiveReadBinding,
} from './store/entity-state';
export type { StaleEntityHandleError, ComponentAbsentError, StaleHandleResult, EditRejectedInPlayError, HandleCheckOpts } from './store/entity-state';

// ── Handle-pair (world-bound handle + three-layer validation) ──
// The world-manager layer holds HandlePairs (worldRef + epoch + entity) instead
// of bare EntityHandles, and validates them through validateHandlePair before
// any read/write — the defence against cross-world reads.
export { validateEntityObjectRef, validateHandlePair } from './store/handle-pair';
export type {
  EntityObjectRefResult,
  EntityObjectRefUnavailableError,
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
export { catalogStoragePath } from './assets/catalog-storage-path';
export type { CatalogStorageLocator } from './assets/catalog-storage-path';

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
  getAnimationComponentMeta,
  getTransportDescriptor,
} from './scene/schema';
export type {
  FieldSchema,
  ComponentSchema,
  FieldType,
  ArrayFieldMeta,
} from './scene/schema';
export { planArrayEdit } from './scene/array-edit';
export type { ArrayEditAction, ArrayEditRequest, ArrayEditPlan } from './scene/array-edit';
// socket-calibration M1 (doc §3.2): read face for a skinned character's joint
// names — the parent-bone dropdown source. Pure read over activeWorld.
// socket-calibration M2 (doc §3.4 / §3.6): joint-root LCA, facing-pivot read,
// socket enumeration for the derived JSON projection.
export {
  findSkinEntity,
  listSkinJoints,
  listSkinJointsFor,
  findJointRoot,
  findFacingPivot,
  readFacingYaw,
  listSkinSockets,
  FACING_PIVOT_NAME,
} from './scene/skin-joints';
export type { SkinJoint, SkinSocket } from './scene/skin-joints';
// socket-calibration M2 (doc §3.6 数据导出): derived JSON projection of the
// authored socket + facing state — a read-only pure-numeric view of the scene
// for one-click copy into external tools (scene-pack stays the SSOT).
export { summarizeCalibration } from './scene/calibration-projection';
export type {
  CalibrationProjection,
  CalibrationCharacterProjection,
  CalibrationSocketProjection,
} from './scene/calibration-projection';
// Editor-owned component metadata overlay (SSOT), injected into
// `Component.meta.editor` post-registration; the engine stays agnostic.
export {
  applyEditorComponentMeta,
  editorMetaOf,
  EDITOR_COMPONENT_META,
} from './scene/editor-component-meta';
export type { EditorComponentMeta } from './scene/editor-component-meta';
export type { AnimationComponentMeta, AnimationTransportDescriptor } from './scene/editor-component-meta';

// ── Animation preview (M1) ──
// Snapshot/restore registry (save-pollution defense) + the setAnimationPreview
// session op. The op registers itself into the session table at module eval
// (side-effect import, same pattern as material-ops).
export {
  snapshotAnimationPreview,
  restoreAnimationPreview,
  restoreAllAnimationPreviews,
  restoreAnimationPreviewsOutside,
  clearAnimationPreviews,
  hasAnimationPreview,
  previewedAnimationEntities,
} from './session/animation-preview';
import './session/animation-preview-ops';

// ── Euler↔quat conversion (SSOT, XYZ order, AGENTS.md #6) ──
export { quatToEuler, eulerToQuat } from './util/euler-quat';

// ── Hex↔float color conversion (used by the Material inspector) ──
export {
  floatToHex,
  hexToFloat,
  hexToMaterialColor,
  materialColorToHex,
  type AuthoredColorSpace,
} from './util/color-utils';

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
// Material Instance ops (create/save/setParent/setOverride/setLightmass).
import './session/material-instance-ops-register';
// Input Map ops (create/save).
import './session/input-map-ops-register';
export { awaitAssetWriteCompletion } from './session/authored-asset-write';

export {
  MATERIAL_INSTANCE_KIND,
  SURFACE_PARAM_KEYS,
  DEFAULT_LIGHTMASS,
  createDefaultMaterialInstancePayload,
  encodeMaterialInstancePackRefs,
  normalizeMaterialInstancePackEntries,
  isMaterialInstancePayload,
  isGuid as isMaterialInstanceGuid,
} from './assets/material-instance-schema';
export {
  INPUT_MAP_KIND,
  INPUT_MAP_SCHEMA_VERSION,
  createDefaultInputMapPayload,
  deleteInputMapMappings,
  diagnoseInputMap,
  filterInputMapActions,
  pasteInputMapMappings,
  repairInputMapErrors,
  reorderInputMapActions,
  isInputMapPayload,
  isGuid as isInputMapGuid,
  toActionConfigs,
} from './assets/input-map-schema';
export type {
  InputMapPayload,
  InputMapAction,
  InputMapActionRow,
  InputMapBinding,
  InputMapDiagnostic,
  InputMapDiagnosticLocation,
  InputMapMappingSelection,
} from './assets/input-map-schema';
export {
  inputMapLoader,
  loadInputMapAsset,
  registerInputMapLoader,
} from './assets/input-map-loader';
export {
  subscribeInputMapStaging,
  getInputMapStaging,
  isInputMapStagingDirty,
  hasInputMapExternalChange,
  renameInputMapStaging,
  setInputMapSaveStatus,
  openInputMapStaging,
  refreshInputMapStaging,
  reloadInputMapStaging,
  keepInputMapStaging,
  updateInputMapStaging,
  commitInputMapStaging,
  discardInputMapStaging,
  closeInputMapStaging,
} from './assets/input-map-staging';
export type { InputMapStagingEntry } from './assets/input-map-staging';
export type {
  MaterialInstancePayload,
  MaterialInstanceOverride,
  MaterialInstanceLightmass,
  SurfaceParamKey,
} from './assets/material-instance-schema';
export {
  resolveOverrides,
  wouldCreateParentCycle,
  getInheritedValue,
  enabledOverrideValues,
} from './assets/material-instance-resolve';
export type {
  MaterialCatalogEntry,
  MaterialCatalogLookup,
} from './assets/material-instance-resolve';
export {
  materialCatalogLookup,
  ensureMaterialChainCataloged,
} from './assets/material-chain-catalog';
export {
  setMaterialPreviewParam,
  clearMaterialPreviewParams,
  getMaterialPreviewParams,
  subscribeMaterialPreviewParams,
} from './assets/material-preview-staging';
export {
  parseShaderParamSchemaIndex,
  ensureShaderParamSchemaIndex,
  resetShaderParamSchemaIndexCache,
  resolveMaterialParamSchema,
  deriveMaterialParamRows,
  resolveTextureRefGuid,
} from './assets/material-param-schema';
export type {
  MaterialParamDescriptor,
  MaterialParamRow,
  MaterialParamRowKind,
  ShaderParamSchemaIndex,
} from './assets/material-param-schema';
export {
  materialInstanceLoader,
  registerMaterialInstanceLoader,
} from './assets/material-instance-loader';
export {
  subscribeMiStaging,
  getMiStaging,
  isMiStagingDirty,
  openMiStaging,
  updateMiStaging,
  commitMiStaging,
  discardMiStaging,
  closeMiStaging,
} from './assets/mi-staging';
export type { MiStagingEntry } from './assets/mi-staging';
export {
  registerActivePageSaveHandler,
  trySaveActivePage,
} from './assets/active-page-save';

// ── Scene presets (blank-create templates) ──
export {
  ENTITY_PRESETS,
  getPreset,
  buildPresetComponents,
} from './scene/presets';
export {
  VISUAL_QUALITY_PRESETS,
  VISUAL_QUALITY_PATCHES,
} from './session/visual-quality';
export type { VisualQualityPreset } from './session/visual-quality';

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
  getGizmoPivot,
  replaceDoc,
  onSelectionChange,
  onRenameRequest,
  onGizmoModeChange,
  onGizmoSpaceChange,
  onGizmoPivotChange,
  requestRefComponent,
  requestRefAsset,
  requestRefEntity,
  requestAddAssetsToChat,
  useDocVersion,
  useGizmoMode,
  useGizmoSpace,
  useGizmoPivot,
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
  useSceneReadModel,
  getSceneAuthoringSession,
  onSceneAuthoringSessionChange,
  useSceneAuthoringSession,
  switchSceneFile,
  previewImportedScene,
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
  subscribePendingDiskSave,
  usePendingDiskSave,
  getSessionDirtyAssets,
  subscribeSessionDirtyAssets,
  clearSessionDirtyAssets,
  clearAllSessionDirtyAssets,
  useSessionDirtyAssets,
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
  configureEditorPageNavigation,
  getActiveEditorAsset,
  openEditorAssetPage,
  useActiveEditorAsset,
} from './store/store';
export type { EditorPageNavigation } from './store/page-navigation';
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

// Asset change observation remains notification-only; authored writes still use gateway ops.
export { subscribeAssetsChanged } from './store/assets-changed';
export type {
  AssetsChangedEvent,
  AssetsChangedHint,
  AssetsChangedSource,
  AssetLifecycleMutation,
} from './store/assets-changed';

// broadcastAssetsError — companion to broadcastAssetsChanged: fire-and-forget
// asset IO that failed AFTER the applier returned ok. Panels subscribe via
// panelBridge.on('assetsError', …) and toast; the applier remains SSOT for
// state mutation (north-star §9). See dev-plan §5 step 3.
export { assetsErrorRevision, broadcastAssetsError, recentAssetsErrors } from './store/assets-error-bus';
export type { AssetsErrorPayload } from './store/assets-error-bus';
export type { SceneFileEntry, PlayConfig, SelectedAsset, MeshStats, GizmoSpace, GizmoPivot, SessionDirtyAsset } from './store/store';

// ── Viewport preferences (session-domain chrome state; setViewportPreferences op) ──
// Same barrel rule as above: getters/hooks/subscribes + storage helpers + the
// write-gate chrome mirror only — user-intent mutation is gateway.dispatch({
// kind: 'setViewportPreferences' }).
export {
  getViewportPreferences,
  onViewportPreferencesChange,
  useViewportPreferences,
  syncViewportPosePreferences,
  defaultViewportPreferences,
  readViewportPreferences,
  normalizeViewportPreferences,
  writeViewportPreferences,
  VIEWPORT_PREFERENCES_STORAGE_KEY,
} from './store/viewport-preferences';
export type {
  CameraBookmark,
  CameraBookmarkSlot,
  ViewportPreferences,
  ViewportPreferencesPatch,
  ViewportPreferencesStorage,
} from './store/viewport-preferences';

// ── Editor-camera view limits (SSOT shared by core prefs + edit-runtime camera math) ──
export {
  clampDist,
  clampFov,
  clampFlySpeed,
  clampOrthoHalfHeight,
  clampPitch,
  FLY_BOOST_MULTIPLIER,
  FLY_SPEED_DEFAULT,
  FLY_SPEED_MAX,
  FLY_SPEED_MIN,
  FOV_DEFAULT,
  FOV_MAX,
  FOV_MIN,
  ORTHO_HALF_HEIGHT_DEFAULT,
  ORTHO_HALF_HEIGHT_MAX,
  ORTHO_HALF_HEIGHT_MIN,
} from './store/viewport-camera-limits';
export type { CameraProjection, ViewportView } from './store/viewport-camera-limits';

// ── Entity operations ──
export {
  deleteEntityCascade,
  deleteManyCascade,
  duplicateEntity,
  groupSelected,
  hideMany,
  hideUnselected,
  setVisibilityMany,
  showAllHidden,
  ungroupEntity,
  reparentEntity,
  reparentMany,
  reparentAt,
  ensureFacingPivot,
  setFacingYaw,
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

// ── Material pack-path clamping (ensure authoring under assets/) ──
export { resolveMaterialCreateGameRelDir, clampMaterialPackPath } from './util/material-pack-path';

// ── Run conditions (`and` combinator for RunCondition-shaped predicates) ──
export { and } from './session/run-conditions';
export type { RunCondition } from './session/run-conditions';
// ── Engine-owned visibility contract ──
export {
  readEntityVisibility,
  readVisibilityIntent,
  resolveVisibility,
  Visibility,
  VisibilityStateValue,
  visibilityStateFromU32,
} from './visibility';
export type { VisibilityResolution, VisibilitySnapshot, VisibilityState } from './visibility';

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
import './io/project-validation-ops';
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
  buildAcceptString,
  getImportRegistrySnapshot,
  logImport,
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
