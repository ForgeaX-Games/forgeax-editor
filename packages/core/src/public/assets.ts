// Public asset projection.
//
// Asset helpers are compatibility projections only. Mutation still enters the
// existing gateway applier and AssetIO seams; this slice does not own state.

export {
  validateAssetBasename,
  checkPathNotJailbreak,
  ASSET_BASENAME_MAX_LENGTH,
} from '../session/asset-basename';
export type { BasenameValidation, PathJailbreakCheck } from '../session/asset-basename';
export { loadRawAssets, materialSwatch, extractPackDirs } from '../assets/assets';
export type { PackAsset, RawAsset } from '../assets/assets';
export {
  buildSpawnEntityFromDragRef,
  recoverMeshOriginalMaterialGuids,
} from '../assets/drag-asset-spawn';
export type { DragAssetRef, SpawnRefEntity } from '../assets/drag-asset-spawn';
export { planAssetPlacement } from '../assets/asset-placement-plan';
export type {
  AssetPlacementPlan,
  AssetPlacementPlanError,
  AssetPlacementPlanOptions,
  AssetPlacementPlanResult,
} from '../assets/asset-placement-plan';
export { spawnAssetRefToScene, requestAddAssetToScene } from '../scene/spawn-asset-ref';
export {
  resolveMeshOriginalMaterials,
  _clearMeshMaterialCache,
} from '../scene/mesh-original-materials';
export type { MeshMaterialResolveDeps, MeshAssetRef } from '../scene/mesh-original-materials';
export { cookGltfMeta } from '../assets/gltf-cook';
export { cookFbxMeta } from '../assets/fbx-cook';
export type { GltfCookResult } from '../assets/gltf-cook';
export type { FbxCookResult } from '../assets/fbx-cook';
export { createAssetBrowserReadModel } from '../assets/asset-browser-read-model';
export type {
  AssetAuthoringCapability,
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
} from '../assets/asset-browser-read-model';
export { assetWorkspaceSnapshotToBrowserSnapshot } from '../assets/asset-browser-read-model';
export type {
  AssetWorkspaceSnapshot,
  AssetWorkspaceInput,
  AssetWorkspaceObservation,
  AssetWorkspaceResult,
} from '@forgeax/editor-product';
export {
  compareAssetWorkspaceSnapshots,
  createAssetWorkspace,
} from '@forgeax/editor-product';
export { assetIO, AssetIOFacade } from '../io/asset-io-facade';
export type {
  AssetIoError,
  AssetIoResult,
  AssetResourceTransactionPort,
  SourceFileDeleteResult,
} from '../io/asset-io-facade';
export type { SourceFileDeleteStatus } from '../session/source-file-delete-status';
export {
  generateAssetGuid,
  renameAssetInPack,
  deleteAsset,
  createDirectory,
  deleteDirectory,
  registerPostAssetWriteCatalogSync,
} from '../session/pack-ops';
export { createImportFailure, executeAssetImport } from '../session/import-ops';
export type {
  AssetImportSpec,
  ImportFailure,
  ImportFailureCode,
  ImportCancellationPolicy,
  ImportFileResult,
  ImportFileStatus,
  ImportProgressEvent,
  ImportProgressStage,
  ImportSubAsset,
} from '../session/import-ops';
export { installAssetHmrBridge } from '../assets/asset-hmr-bridge';
export { ensureAssetCataloged } from '../assets/ensure-asset-cataloged';
export {
  createAssetMutationSafetyAdapter,
  createAssetProducerAdapter,
} from '../product/asset-producer-adapter';
export type {
  AssetMutationSafetyAdapter,
  AssetMutationSafetyAdapterOptions,
  AssetProducerAdapter,
  AssetProducerAvailability,
  AssetProducerSource,
} from '../product/asset-producer-adapter';
export {
  authorizeAssetMutation,
  createAssetLifecycleAdapter,
  getAssetSubjectCapability,
  preflightAssetMutation,
  reconcileImportedTopology,
} from '@forgeax/editor-product';
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
  ImportedOutputRecord,
  ImportedOutputReference,
  ReimportTopologyResult,
} from '@forgeax/editor-product';
export { createResourceTransactionAdapter } from '../product/resource-transaction';
export type {
  PreparedResourceTransaction,
  ResourceChangePort,
  ResourceMutationPort,
  ResourceMutationResultPort,
  ResourceResultPort,
  ResourceRootPort,
  ResourceSnapshotPort,
  ResourceTransactionAdapter,
} from '../product/resource-transaction';
