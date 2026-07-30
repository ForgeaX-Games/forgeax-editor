// UI-free Editor product contract shell.
//
// The product package exposes typed facts and structured availability only. It
// does not import React, a browser host, an engine World, or a producer parser.

import {
  PRODUCT_CONTRACT_MANIFEST,
  PRODUCT_CONTRACT_VERSION,
} from './contracts/manifest';
import type { ProductContractManifest } from './contracts/manifest';
import {
  CapabilityRegistry,
  type CapabilityDiscoveryOptions,
} from './kernel/capability-registry';
import type { CapabilityDescriptor } from './contracts/capability';
import type { CapabilityManifest } from './contracts/manifest';

export {
  PRODUCT_CONTRACT_MANIFEST,
  PRODUCT_CONTRACT_MANIFEST_VERSION,
  PRODUCT_CONTRACT_VERSION,
} from './contracts/manifest';
export type { ProductContractManifest } from './contracts/manifest';
export {
  capabilityId,
  isCapabilityDescriptor,
  unavailableCapability,
} from './contracts/capability';
export type {
  CapabilityAvailability,
  CapabilityDescriptor,
  CapabilityExecutor,
  CapabilityHost,
  CapabilityKind,
  CapabilityPermission,
  CapabilityRegistration,
  CapabilitySchema,
} from './contracts/capability';
export {
  createCommandError,
  isCommandError,
  unavailable,
} from './contracts/error';
export type { CommandError, CommandErrorCode } from './contracts/error';
export {
  acceptedEvent,
  createOperationRun,
  isTerminalRunStatus,
  reduceOperationRun,
  OPERATION_RUN_SCHEMA_VERSION,
} from './contracts/run';
export type {
  OperationRun,
  OperationRunEvent,
  OperationRunEventInput,
  OperationRunRequest,
  OperationRunStatus,
  RunActor,
  RunProgress,
  TerminalRunStatus,
} from './contracts/run';
export {
  OperationRunCoordinator,
  REPRESENTATIVE_OPERATION_IDS,
  RunCoordinator,
} from './kernel/run-coordinator';
export type {
  OperationDefinition,
  RunAcceptedResult,
  RunCoordinatorEvent,
  RunEventInput,
  RunCoordinatorOptions,
} from './kernel/run-coordinator';
export { RunJournal } from './kernel/run-journal';
export type {
  RunJournalEventInput,
  RunJournalAcceptResult,
  RunJournalOptions,
  RunJournalRecord,
  RunJournalResult,
} from './kernel/run-journal';
export {
  CapabilityRegistry,
  CapabilityRegistrationError,
  compareHostCapabilities,
} from './kernel/capability-registry';
export type { CapabilityDiscoveryOptions, HostParityReport } from './kernel/capability-registry';
export {
  createCapabilityManifest,
  PRODUCT_CAPABILITY_MANIFEST_VERSION,
} from './contracts/manifest';
export type { CapabilityManifest } from './contracts/manifest';
export { CommitCollar } from './kernel/commit-collar';
export type { UndoRedoRequest } from './kernel/commit-collar';
export type {
  AuthoredCommit,
  AuthoredHistoryPort,
  CanonicalEffect,
  CanonicalEffectContext,
  CanonicalEffectPort,
  CommitEvent,
  CommitPhase,
  CommitRequest,
  CommitResult,
  CommitRunRequest,
  PreparedResource,
  ResourceCommitResult,
  ResourcePrepareContext,
  ResourceTransactionPort,
} from './contracts/commit';
export {
  ASSET_WORKSPACE_SCHEMA_VERSION,
  createAssetSubject,
  createAssetWorkspaceSnapshot,
} from './contracts/asset-workspace';
export type {
  AssetProvenance,
  AssetProvenanceOwner,
  AssetRelation,
  AssetRelationKind,
  AssetSubject,
  AssetSubjectCapabilities,
  AssetSubjectId,
  AssetSubjectInput,
  AssetSubjectKind,
  AssetMutationOperation,
  AssetMutationRequest,
  AssetWorkspaceIssue,
  AssetWorkspaceIssueCode,
  AssetWorkspaceIssueSeverity,
  AssetWorkspaceSnapshot,
  CreateAssetWorkspaceSnapshotInput,
} from './contracts/asset-workspace';
export {
  compareAssetWorkspaceSnapshots,
  createAssetWorkspace,
} from './assets/workspace';
export type {
  AssetWorkspace,
  AssetWorkspaceDelta,
  AssetWorkspaceInput,
  AssetWorkspaceObservation,
  AssetWorkspaceRecoveryIntent,
  AssetWorkspaceReconcileResult,
  AssetWorkspaceResult,
} from './assets/workspace';
export { createSourceMetaReconciler } from './assets/reconcile';
export type {
  SourceMetaObservation,
  SourceMetaReconcileResult,
  SourceMetaReconciler,
  SourceMetaRegistration,
} from './assets/reconcile';
export {
  authorizeAssetMutation,
  createAssetLifecycleAdapter,
  findAssetSubject,
  preflightAssetMutation,
  preflightAssetSubject,
  subjectSupports,
} from './assets/preflight';
export type {
  AssetLifecycleAdapter,
  AssetLifecycleAdapterOptions,
  AssetMutationCommitResult,
  AssetMutationError,
  AssetMutationErrorCode,
  AssetMutationImpact,
  AssetMutationResult,
  AssetPreflightOptions,
  AssetPreflightResult,
  AssetSubjectAction,
} from './assets/preflight';
export {
  getAssetSubjectCapability,
  reconcileImportedTopology,
} from './assets/subject-capability';
export { ASSET_CONFORMANCE_SCENARIOS, runAssetConformance } from './assets/conformance-driver';
export type { AssetConformanceScenario } from './assets/conformance-driver';
export {
  createAssetConformanceReport,
  validateAssetConformanceFixtures,
} from './assets/conformance-report';
export type {
  AssetConformanceFailure,
  AssetConformanceFixtureIssue,
  AssetConformanceFixtureValidation,
  AssetConformanceReport,
} from './assets/conformance-report';
export type {
  AssetSubjectCapability,
  ImportedOutputRecord,
  ImportedOutputReference,
  ReimportTopologyAmbiguity,
  ReimportTopologyInput,
  ReimportTopologyMatch,
  ReimportTopologyResult,
  SubjectOperationAvailability,
  SubjectOperationReason,
} from './assets/subject-capability';
export {
  RUNTIME_CONTRACT_VERSION,
  RuntimeAvailabilitySchema,
  RuntimeOperationSchema,
  createRuntimeAvailability,
  createStaleRuntimeHandleError,
  runtimeError,
  unavailableRuntimeError,
} from './contracts/runtime';
export type {
  GameRuntimePort,
  RuntimeAvailability,
  RuntimeCapability,
  RuntimeEntityHandle,
  RuntimeHost,
  RuntimeOperation,
  RuntimeResult,
  RuntimeWorldHandle,
} from './contracts/runtime';
export {
  TRANSPORT_PROTOCOL_VERSION,
  TransportRequestSchema,
  TransportResponseSchema,
  createProtocolError,
  decodeNdjson,
  encodeNdjson,
  parseTransportMessage,
} from './transport/protocol';
export type { TransportRequest, TransportResponse } from './transport/protocol';
export {
  authorizeTransportRequest,
  createTransportSecurityPolicy,
  createTransportService,
  decodeTransportCursor,
  encodeTransportCursor,
  eventsAfterCursor,
  isTerminalTransportNotification,
  paginateCollection,
  validateTransportScope,
} from './transport/service';
export type {
  TransportAuthorizationRequest,
  TransportAuthorizationResult,
  TransportSecurityPolicy,
  TransportService,
  TransportServiceOptions,
} from './transport/service';
export { createStdioCarrier } from './transport/stdio-carrier';
export type { StdioCarrier } from './transport/stdio-carrier';
export { createHeadlessRuntime, headlessAvailability } from './runtime/headless-runtime';
export {
  expandWorkflowRecipe,
  WORKFLOW_SCHEMA_VERSION,
} from './contracts/workflow';
export type {
  ExpandedWorkflowRecipe,
  WorkflowCapabilityLookup,
  WorkflowChildRun,
  WorkflowFailurePolicy,
  WorkflowRecoveryAction,
  WorkflowRecipe,
  WorkflowRecipeResult,
  WorkflowRecipeStep,
  WorkflowResult,
  WorkflowRun,
} from './contracts/workflow';
export { WorkflowRecipeRegistry } from './kernel/workflow-recipes';
export { WorkflowCoordinator } from './kernel/workflow-coordinator';
export type {
  WorkflowCoordinatorOptions,
  WorkflowStartRequest,
  WorkflowStartResult,
  WorkflowStartSuccess,
} from './kernel/workflow-coordinator';
export { reconcileRestartedRuns } from './kernel/run-reconciliation';
export {
  isWorkflowRecoveryAction,
  recoverWorkflow,
  recoveryActionsForWorkflow,
} from './kernel/workflow-recovery';
export type {
  RestartReconciliationOptions,
  RestartReconciliationResult,
} from './kernel/run-reconciliation';
export type {
  WorkflowRecoveryPort,
  WorkflowRecoveryRequest,
  WorkflowRecoveryResult,
} from './kernel/workflow-recovery';

/** Product-level gate used while a required host adapter is absent. */
export interface ProductBlockingAvailability {
  readonly available: false;
  readonly blocking: true;
  readonly code: 'wave1-input-blocked';
  readonly hint: string;
  readonly issues: readonly string[];
}

/** Product-level fact that the current host has connected its adapter. */
export interface ProductAvailableAvailability {
  readonly available: true;
  readonly blocking: false;
  readonly code: 'product-available';
}

export type ProductAvailability =
  | ProductBlockingAvailability
  | ProductAvailableAvailability;

/**
 * UI-free product facade shared by UI, Bun, and host adapters.
 *
 * The registry is the capability SSOT. This facade derives discovery facts
 * from it and does not maintain a second hand-written capability list.
 */
export interface EditorProduct {
  readonly contractVersion: string;
  readonly manifest: ProductContractManifest;
  readonly availability: ProductAvailability;
  readonly capabilityRegistry: CapabilityRegistry;
  /** Return the contract, derived capability manifest, and product gate. */
  discover(): {
    manifest: ProductContractManifest;
    capabilityManifest: CapabilityManifest;
    availability: ProductAvailability;
  };
  /** List capabilities after applying host and availability filters. */
  discoverCapabilities(options?: CapabilityDiscoveryOptions): readonly CapabilityDescriptor[];
  /** Look up one canonical `subject.verb` capability for preflight. */
  describeCapability(id: string, options?: CapabilityDiscoveryOptions): CapabilityDescriptor | undefined;
}

/** Construction options for the shared product facade. */
export interface CreateEditorProductOptions {
  readonly availability?: ProductAvailability;
  readonly capabilityRegistry?: CapabilityRegistry;
}

/** Build the explicit blocking fact used before Wave 1 adapters connect. */
export function blockingAvailability(
  issues: readonly string[] = ['wave1-public-adapter-unavailable'],
): ProductBlockingAvailability {
  return Object.freeze({
    available: false,
    blocking: true,
    code: 'wave1-input-blocked',
    hint: 'Wave 1 compatibility evidence is required before producer-dependent capabilities can run.',
    issues: Object.freeze([...issues]),
  });
}

/** Create the shared discovery facade around one capability registry. */
export function createEditorProduct(
  options: ProductAvailability | CreateEditorProductOptions = blockingAvailability(),
): EditorProduct {
  const availability = 'available' in options
    ? options
    : options.availability ?? blockingAvailability();
  const capabilityRegistry = 'available' in options
    ? new CapabilityRegistry()
    : options.capabilityRegistry ?? new CapabilityRegistry();
  const product: EditorProduct = {
    contractVersion: PRODUCT_CONTRACT_VERSION,
    manifest: PRODUCT_CONTRACT_MANIFEST,
    availability,
    capabilityRegistry,
    discover() {
      return {
        manifest: PRODUCT_CONTRACT_MANIFEST,
        capabilityManifest: capabilityRegistry.manifest(),
        availability,
      };
    },
    discoverCapabilities(discoveryOptions = {}) {
      return capabilityRegistry.discover(discoveryOptions);
    },
    describeCapability(id, discoveryOptions = {}) {
      return capabilityRegistry.describe(id, discoveryOptions);
    },
  };
  return Object.freeze(product);
}
