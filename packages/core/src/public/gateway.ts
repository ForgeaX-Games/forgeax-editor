// Public gateway projection.
//
// This file owns the stable product-neutral gateway/catalog surface. The
// implementation remains in io/ so the existing executor and registration
// tables stay single-source-of-truth.

export { EditGateway, assertThinGatewayOwnerSurface, createThinGatewayProjection } from '../io/gateway';
export type { ThinAuthoringRunRequest, ThinGatewayRunPort } from '../io/gateway';
export type {
  AssetImpactAsset,
  AssetImpactEdge,
  AssetImpactResult,
  AssetMutationPreviewOperation,
  AssetMutationPreviewRequest,
} from '../io/asset-impact';
export type {
  ApplierCtx,
  AssetSummary,
  AssetSummaryResult,
  BusListener,
  CommandOrigin,
  DispatchResult,
  HistoryDiff,
  HistoryStep,
  OpHandle,
} from '../io/gateway';
export type { SelectionReadModel } from '../io/selection-read-model';
export type { CollectSceneAssetResult } from '../io/scene-asset-collect';
export type { SceneReadModel, SceneReadModelEntry, SceneReadModelReference } from '../io/scene-read-model';
export type {
  SceneInstanceMemberReadModel,
  SceneInstanceOverrideReadModel,
  SceneInstanceReadModel,
  SceneInstanceReadResult,
  SceneInstanceSourceReadModel,
} from '../io/scene-instance-read-model';
export type {
  SceneAuthoringMode,
  SceneAuthoringSaveTarget,
  SceneAuthoringSessionReadModel,
} from '../io/scene-authoring-session';
export { createEngineFacade } from '../io/engine-facade';
export type { EngineFacade } from '../io/engine-facade';
export { registerSessionApplier, registerTransientApplier } from '../io/appliers';
export { GatewayWriteBarrier, acquireGatewayWrite, getGatewayWriteBarrier, registerGatewayWriteBarrier } from '../io/gateway-write-barrier';
export type { GatewayWriteAcquireResult, GatewayWriteBarrierSnapshot, GatewayWriteKind, GatewayWriteLease, GatewayWritePhase } from '../io/gateway-write-barrier';
export type { SessionApplier, SessionApplierMeta } from '../io/appliers';
export {
  VERSION_CONTROL_ERROR_CODES,
  VERSION_CONTROL_OPERATION_IDS,
  createVersionControlSnapshotEnvelope,
  isVersionControlOperationId,
  isVersionControlSnapshotForGeneration,
} from '../io/version-control-schema';
export type {
  VersionControlDirtyRecord,
  VersionControlErrorCode,
  VersionControlGraph,
  VersionControlOperationDescriptor,
  VersionControlOperationId,
  VersionControlSnapshot,
  VersionControlSnapshotEnvelope,
} from '../io/version-control-schema';
export { versionControlOperationDescriptors } from '../io/catalog';
export { VersionControlSnapshotClient } from '../io/viewport-runtime-client';
export { createVersionControlCommandError, normalizeVersionControlFailure } from '../io/errors';
export type { VersionControlCommandErrorInput } from '../io/errors';
export type {
  ArgsSchema,
  GatewayOpAvailability,
  GatewayOpDescriptor,
  GatewayOpSnapshot,
  OpDescriptor,
} from '../io/catalog';
export { createCatalogReconcileProvider } from '../io/catalog';
export type {
  CatalogReconcileProvider,
  CatalogReconcileResult,
  EngineCatalogReconcileProvider,
} from '../io/catalog';
export type { OperationRunDescriptor } from '../io/catalog';
export { OperationRunRegistry } from '../io/operation-runs';
export type {
  OperationRun,
  OperationRunListener,
  OperationRunReadResult,
  OperationRunRegistryOptions,
  OperationRunSnapshot,
} from '../io/operation-runs';
export {
  createGatewayCapabilityAdapter,
  createEditorCarrierFacade,
  EDITOR_CARRIER_CONTRACT_VERSION,
  EDITOR_CARRIER_RECOVERY_ACTIONS,
} from '../product/gateway-executor';
export { createGatewayCommitCollar } from '../product/commit-collar';
export type {
  GatewayCapabilityAdapter,
  GatewayCapabilitySource,
  GatewayDispatchResult,
  CreateEditorCarrierFacadeOptions,
  EditorCarrierDiscovery,
  EditorCarrierFacade,
  EditorCarrierSchemaDescriptor,
  EditorPageCarrierDescriptor,
} from '../product/gateway-executor';
export type {
  GatewayCommitCollar,
  GatewayCommitCollarOptions,
  GatewayCommitRequest,
  GatewayReplayRequest,
} from '../product/commit-collar';
export { createDiagnosticsReadModel, queryDiagnosticsSnapshot } from '../io/diagnostics';
export { runtimeReadinessDiagnostic } from '../io/diagnostics';
export type { RuntimeReadinessDiagnostic } from '../io/diagnostics';
export { createRuntimeReadiness, RUNTIME_READINESS_STATES } from '../io/vfx-runtime-readiness';
export type {
  CreateRuntimeReadinessInput,
  RuntimeReadiness,
  RuntimeReadinessState,
  RuntimeRevision,
} from '../io/vfx-runtime-readiness';
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
} from '../io/diagnostics';
