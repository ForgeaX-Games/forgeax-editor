// Public gateway projection.
//
// This file owns the stable product-neutral gateway/catalog surface. The
// implementation remains in io/ so the existing executor and registration
// tables stay single-source-of-truth.

export { EditGateway } from '../io/gateway';
export type {
  ApplierCtx,
  AssetSummary,
  AssetSummaryResult,
  BusListener,
  CommandOrigin,
  DispatchResult,
  HistoryStep,
  OpHandle,
} from '../io/gateway';
export type { CollectSceneAssetResult } from '../io/scene-asset-collect';
export type { SceneReadModel, SceneReadModelEntry, SceneReadModelReference } from '../io/scene-read-model';
export type {
  SceneAuthoringMode,
  SceneAuthoringSaveTarget,
  SceneAuthoringSessionReadModel,
} from '../io/scene-authoring-session';
export { createEngineFacade } from '../io/engine-facade';
export type { EngineFacade } from '../io/engine-facade';
export { registerSessionApplier } from '../io/appliers';
export type { SessionApplier, SessionApplierMeta } from '../io/appliers';
export type { ArgsSchema, OpDescriptor } from '../io/catalog';
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
  createEditorProductFromGateway,
  createGatewayCapabilityAdapter,
} from '../product/gateway-executor';
export { createGatewayCommitCollar } from '../product/commit-collar';
export type {
  GatewayCapabilityAdapter,
  GatewayCapabilitySource,
  GatewayDispatchResult,
} from '../product/gateway-executor';
export type {
  GatewayCommitCollar,
  GatewayCommitCollarOptions,
  GatewayCommitRequest,
  GatewayReplayRequest,
} from '../product/commit-collar';
export { createDiagnosticsReadModel, queryDiagnosticsSnapshot } from '../io/diagnostics';
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
} from '../io/diagnostics';
