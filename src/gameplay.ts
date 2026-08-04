// @forgeax/editor/gameplay — public versioned gameplay carrier facade.
//
// This pass-through keeps host consumers on a stable public entry while the
// implementation remains in the editor-core package.
export {
  GAMEPLAY_OPERATION_MANIFEST,
  GAMEPLAY_CARRIER_CONTRACT_VERSION,
  GameplayCaptureArtifactSchema,
  GameplayCaptureProvenanceSchema,
  GameplayErrorSchema,
  GameplayIdentitySchema,
  GameplayInputSchema,
  GameplayOperationNameSchema,
  GameplayOperationRequestSchema,
  GameplayOperationResultSchema,
  GameplayOperationSuccessSchema,
  GameplayOperationFailureSchema,
  GameplayScopeSchema,
  createGameplayCaptureGateway,
  createGameplayCarrierBridge,
  createGameplayOperations,
  executeLiveGameplay,
  registerLiveGameplayBridge,
  sameGameplayIdentity,
} from '@forgeax/editor-core';
export type {
  GameplayCaptureArtifact,
  GameplayCaptureGateway,
  GameplayCaptureProvenance,
  GameplayCaptureSurface,
  GameplayCarrierBridge,
  GameplayError,
  GameplayIdentity,
  GameplayIdentityDimension,
  GameplayIdentityMatch,
  GameplayInput,
  GameplayOperationName,
  GameplayOperationManifestEntry,
  GameplayOperationRequest,
  GameplayOperationResult,
  GameplayOperations,
  GameplayScope,
} from '@forgeax/editor-core';
