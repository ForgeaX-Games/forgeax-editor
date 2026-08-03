// Thin root entry for the UI-free Editor product contract.
//
// Business behavior remains in @forgeax/editor-product. This file only keeps
// the root package's public export map discoverable to Bun consumers.

export {
  blockingAvailability,
  createEditorProduct,
  PRODUCT_CONTRACT_MANIFEST,
  PRODUCT_CONTRACT_MANIFEST_VERSION,
  PRODUCT_CONTRACT_VERSION,
} from '@forgeax/editor-product';
export type {
  EditorProduct,
  ProductAvailability,
  ProductAvailableAvailability,
  ProductBlockingAvailability,
  ProductContractManifest,
} from '@forgeax/editor-product';

export { createAssetWorkspace } from '@forgeax/editor-product';
export type {
  AssetWorkspace,
  AssetWorkspaceDelta,
  AssetWorkspaceInput,
  AssetWorkspaceObservation,
  AssetWorkspaceRecoveryIntent,
  AssetWorkspaceReconcileResult,
  AssetWorkspaceResult,
} from '@forgeax/editor-product';

export {
  CapabilityRegistry,
  OperationRunCoordinator,
  RunCoordinator,
  RunJournal,
} from '@forgeax/editor-product';
export type {
  CapabilityDiscoveryOptions,
  HostParityReport,
  OperationDefinition,
  OperationRun,
  OperationRunEvent,
  OperationRunEventInput,
  OperationRunRequest,
  OperationRunStatus,
  RunAcceptedResult,
  RunActor,
  RunCoordinatorEvent,
  RunCoordinatorOptions,
  RunEventInput,
  RunJournalAcceptResult,
  RunJournalEventInput,
  RunJournalOptions,
  RunJournalRecord,
  RunJournalResult,
  RunProgress,
  TerminalRunStatus,
} from '@forgeax/editor-product';

export {
  acceptedEvent,
  createOperationRun,
  isTerminalRunStatus,
  reduceOperationRun,
  OPERATION_RUN_SCHEMA_VERSION,
  REPRESENTATIVE_OPERATION_IDS,
} from '@forgeax/editor-product';

export {
  ASSET_WORKSPACE_SCHEMA_VERSION,
  authorizeAssetMutation,
  compareAssetWorkspaceSnapshots,
  createAssetLifecycleAdapter,
  createAssetSubject,
  createAssetWorkspaceSnapshot,
  findAssetSubject,
  getAssetSubjectCapability,
  preflightAssetMutation,
  preflightAssetSubject,
  subjectSupports,
} from '@forgeax/editor-product';
export type {
  AssetLifecycleAdapter,
  AssetLifecycleAdapterOptions,
  AssetMutationCommitResult,
  AssetMutationError,
  AssetMutationErrorCode,
  AssetMutationImpact,
  AssetMutationOperation,
  AssetMutationRequest,
  AssetMutationResult,
  AssetProvenance,
  AssetProvenanceOwner,
  AssetRelation,
  AssetRelationKind,
  AssetSubject,
  AssetSubjectAction,
  AssetSubjectCapabilities,
  AssetSubjectId,
  AssetSubjectInput,
  AssetSubjectKind,
  AssetWorkspaceIssue,
  AssetWorkspaceIssueCode,
  AssetWorkspaceIssueSeverity,
  AssetWorkspaceSnapshot,
  AssetPreflightOptions,
  AssetPreflightResult,
  CreateAssetWorkspaceSnapshotInput,
} from '@forgeax/editor-product';

export {
  RUNTIME_CONTRACT_VERSION,
  TRANSPORT_PROTOCOL_VERSION,
  createRuntimeAvailability,
  createStdioCarrier,
  createTransportSecurityPolicy,
  createTransportService,
  decodeNdjson,
  encodeNdjson,
  parseTransportMessage,
} from '@forgeax/editor-product';
// Hosts must consume the Gateway-backed product adapter through this facade;
// the editor-core implementation remains behind the package boundary.
export {
  createEditorProductFromGateway,
  createGatewayCapabilityAdapter,
} from '@forgeax/editor-core';
export {
  createBrowserGameRuntimePort,
} from '@forgeax/editor-edit-runtime';
export type {
  BrowserGameRuntimePort,
  BrowserGameRuntimePortOptions,
  BrowserRuntimeAvailability,
} from '@forgeax/editor-edit-runtime';
export type {
  GameRuntimePort,
  RuntimeAvailability,
  RuntimeResult,
  TransportRequest,
  TransportResponse,
  TransportService,
  TransportServiceOptions,
} from '@forgeax/editor-product';
