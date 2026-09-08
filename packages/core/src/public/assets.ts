// Public asset projection.
//
// Asset helpers are compatibility projections only. Mutation still enters the
// existing gateway applier and AssetIO seams; this slice does not own state.

export type {
	AssetAuthoringCapability,
	AssetBrowserAsset,
	AssetBrowserCatalogRelation,
	AssetBrowserCatalogRoot,
	AssetBrowserDiagnostic,
	AssetBrowserDirectory,
	AssetBrowserFile,
	AssetBrowserReadModel,
	AssetBrowserRegistry,
	AssetBrowserRegistryEntry,
	AssetBrowserRelationKind,
	AssetBrowserSnapshot,
	AssetBrowserTreeNode,
	AssetSourcePhase,
	AssetSourceState,
	CreateAssetBrowserReadModelDeps,
} from "../assets/asset-browser-read-model";
export {
	assetWorkspaceSnapshotToBrowserSnapshot,
	createAssetBrowserReadModel,
	projectScriptablePackCatalog,
	projectScriptablePackCatalogRows,
} from "../assets/asset-browser-read-model";
export type {
	AssetPlacementPlan,
	AssetPlacementPlanError,
	AssetPlacementPlanOptions,
	AssetPlacementPlanResult,
} from "../assets/asset-placement-plan";
export { planAssetPlacement } from "../assets/asset-placement-plan";
export type { PackAsset, RawAsset } from "../assets/assets";
export {
	extractPackDirs,
	loadRawAssets,
	materialSwatch,
} from "../assets/assets";
export type { DragAssetRef, SpawnRefEntity } from "../assets/drag-asset-spawn";
export { buildSpawnEntityFromDragRef } from "../assets/drag-asset-spawn";
export type { FbxCookResult } from "../assets/fbx-cook";
export { cookFbxMeta, mergeFbxImportSettings } from "../assets/fbx-cook";
export { resolveFbxImportDependencies } from "../assets/fbx-cook";
export type {
	FbxDependencyCandidate,
	FbxDependencyResolution,
} from "../assets/fbx-cook";
export type { GltfCookResult } from "../assets/gltf-cook";
export { cookGltfMeta } from "../assets/gltf-cook";
export type {
	SourceAuthoringOperationDescriptor,
	SourceAuthoringRuntime,
	SourceAuthoringRuntimeResult,
} from "../session/source-authoring-ops";
export { installSourceAuthoringOps } from "../session/source-authoring-ops";
export {
	projectScriptablePackReadModel,
	SCRIPTABLE_PACK_READ_MODEL_SCHEMA,
} from "../assets/scriptable-pack-read-model";
export type {
	ScriptablePackDependencyProjection,
	ScriptablePackDependencyStatus,
	ScriptablePackEvidenceUsage,
	ScriptablePackExternalEvidence,
	ScriptablePackOutputReadModel,
	ScriptablePackReadModel,
	ScriptablePackReadModelFailure,
	ScriptablePackReadModelInput,
	ScriptablePackReadModelStatus,
	ScriptablePackSourceReadModel,
} from "../assets/scriptable-pack-read-model";
export type {
	ActiveSceneSourceReference,
	AssetIoSourceOutput,
	AssetIoSourceSnapshot,
	AssetSourceReadFact,
	CoordinatedSourceMutationPreflightResult,
	SourceMutationErrorSubjectRef,
	SourceMutationOperationIdentity,
	SourceMutationPreflightCommand,
	SourceMutationPreflightCoordinator,
	SourceMutationPreflightError,
	SourceMutationPreflightInput,
	SourceMutationPreflightResult,
	SourceMutationProjectionError,
} from "../assets/source-mutation-preflight";
export {
	createSourceMutationPreflightCoordinator,
	preflightSourceMutation,
	readAssetSourceFact,
} from "../assets/source-mutation-preflight";
export type {
	GeneratedSceneRefreshError,
	GeneratedSceneRefreshHost,
	GeneratedSceneRefreshOutcome,
	GeneratedSceneRefreshRequest,
	GeneratedSceneRefreshResult,
	GeneratedSceneStagedTree,
	GeneratedSceneWrapperSnapshot,
} from "../scene/generated-scene-refresh";
export { createGeneratedSceneRefreshOwner } from "../scene/generated-scene-refresh";
export { refreshGeneratedSceneInstances } from "../scene/generated-scene-refresh-runtime";
export {
	requestAddAssetToScene,
	spawnAssetRefToScene,
	validateMeshRendererMaterialBinding,
} from "../scene/spawn-asset-ref";
export type {
	BasenameValidation,
	PathJailbreakCheck,
} from "../session/asset-basename";
export {
	ASSET_BASENAME_MAX_LENGTH,
	checkPathNotJailbreak,
	validateAssetBasename,
} from "../session/asset-basename";
export type {
	ScriptablePackRecoveryAction,
	ScriptablePackRecoveryInput,
	ScriptablePackRecoveryPlan,
	SourceAuthoringOperationManifestEntry,
} from "../session/scriptable-pack-ops";
export {
	GENERATED_SCENE_RECOVERY_ACTIONS,
	planScriptablePackRecovery,
	recoveryActionsForScriptablePackError,
	SCRIPTABLE_PACK_RECOVERY_ACTIONS,
	sourceAuthoringOperationManifest,
} from "../session/scriptable-pack-ops";
/**
 * Public source-authoring error index. AI callers branch on `code` and the
 * structured recovery fields below; `hint` is explanatory text only.
 */
export type AssetSourceAuthoringErrorCode =
	| "asset-source-key-missing"
	| "asset-source-key-unknown"
	| "asset-source-key-ambiguous"
	| "asset-meta-revision-conflict"
	| "asset-confirmation-required"
	| "asset-confirmation-expired"
	| "asset-confirmation-mismatch"
	| "asset-validation-failed"
	| "asset-cook-failed"
	| "asset-publish-observation-timeout"
	| "asset-catalog-subscription-gap"
	| "asset-operation-cas-committed"
	| "run-cancelled-before-cas";

/** One Gateway-correlated failure fact from preflight through publication. */
export interface AssetSourceAuthoringError {
	readonly code: AssetSourceAuthoringErrorCode;
	readonly phase:
		| "preflight"
		| "entry"
		| "cas"
		| "cook"
		| "validation"
		| "publication"
		| "gap";
	readonly operationId: string;
	readonly requestId: string;
	readonly runId?: string;
	readonly subjectRef: {
		readonly kind: "asset-source";
		readonly guid: string;
		readonly sourceKey?: string;
	};
	readonly hint: string;
	readonly expected?: string;
	readonly actual?: string;
	readonly retryable: boolean;
	readonly recoveryActions: readonly string[];
}
export type {
	AssetLifecycleAdapter,
	AssetLifecycleAdapterOptions,
	AssetMutationError,
	AssetMutationImpact,
	AssetMutationOperation,
	AssetMutationRequest,
	AssetMutationResult,
	AssetPreflightOptions,
	AssetPreflightResult,
	AssetSubjectCapability,
	AssetWorkspaceInput,
	AssetWorkspaceObservation,
	AssetWorkspaceResult,
	AssetWorkspaceSnapshot,
	ImportedOutputRecord,
	ImportedOutputReference,
	ReimportTopologyResult,
} from "@forgeax/editor-product";
export {
	authorizeAssetMutation,
	compareAssetWorkspaceSnapshots,
	createAssetLifecycleAdapter,
	createAssetWorkspace,
	getAssetSubjectCapability,
	preflightAssetMutation,
	reconcileImportedTopology,
} from "@forgeax/editor-product";
export { installAssetHmrBridge } from "../assets/asset-hmr-bridge";
export type { AuthoredAssetCatalogBarrierOptions } from "../assets/authored-asset-barrier";
export { createAuthoredAssetCatalogBarrier } from "../assets/authored-asset-barrier";
export { ensureAssetCataloged } from "../assets/ensure-asset-cataloged";
export type {
	AuthoredSceneFact,
	SceneActivationAssetFacts,
	SceneActivationDescriptor,
	SceneActivationMode,
	SceneActivationUnavailable,
} from "../assets/scene-activation";
export { describeSceneActivation } from "../assets/scene-activation";
export type {
	AssetIoError,
	AssetIoResult,
	AssetResourceRef,
	AssetResourceSnapshot,
	AssetResourceTransactionPort,
	CreateAssetInPackResult,
	SourceFileDeleteResult,
	SourceOverrideCommitInput,
	SourceOverrideCommitResult,
} from "../io/asset-io-facade";
export {
	AssetIOFacade,
	AssetResourceConflictError,
	assetIO,
	SOURCE_SIDECAR_REVISION_DOMAIN,
} from "../io/asset-io-facade";
export type {
	AssetMutationSafetyAdapter,
	AssetMutationSafetyAdapterOptions,
	AssetProducerAdapter,
	AssetProducerAvailability,
	AssetProducerSource,
} from "../product/asset-producer-adapter";
export {
	createAssetMutationSafetyAdapter,
	createAssetProducerAdapter,
} from "../product/asset-producer-adapter";
export type {
	PreparedResourceTransaction,
	ResourceChangePort,
	ResourceMutationPort,
	ResourceMutationResultPort,
	ResourceResultPort,
	ResourceRootPort,
	ResourceSnapshotPort,
	ResourceTransactionAdapter,
} from "../product/resource-transaction";
export { createResourceTransactionAdapter } from "../product/resource-transaction";
export type {
	AuthoredInlineAssetSnapshot,
	AuthoredMaterialReadiness,
	AuthoredMaterialWriteStage,
} from "../session/authored-asset-write";
export {
	awaitAuthoredMaterialReady,
	awaitPostAssetWriteCatalogSync,
	registerAuthoredInlineAssetTracker,
	registerPostAssetWriteCatalogSync,
} from "../session/authored-asset-write";
export type {
	AssetImportSpec,
	ImportCancellationPolicy,
	ImportFailure,
	ImportFailureCode,
	ImportFileResult,
	ImportFileStatus,
	ImportProgressEvent,
	ImportProgressStage,
	ImportSubAsset,
} from "../session/import-ops";
export { createImportFailure, executeAssetImport } from "../session/import-ops";
export {
	createDirectory,
	deleteAsset,
	deleteDirectory,
	generateAssetGuid,
	renameAssetInPack,
} from "../session/pack-ops";
export type { SourceFileDeleteStatus } from "../session/source-file-delete-status";
