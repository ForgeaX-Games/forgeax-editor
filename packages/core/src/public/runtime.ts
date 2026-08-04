// Public runtime projection.
//
// Gameplay schemas and adapters stay implemented in io/, while this slice is
// the stable product-neutral import surface for host adapters.

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
  sameGameplayIdentity,
} from '../io/gameplay-contract';
export type {
  GameplayCaptureArtifact,
  GameplayCaptureProvenance,
  GameplayError,
  GameplayIdentity,
  GameplayIdentityDimension,
  GameplayIdentityMatch,
  GameplayInput,
  GameplayOperationName,
  GameplayOperationManifestEntry,
  GameplayOperationRequest,
  GameplayOperationResult,
  GameplayScope,
} from '../io/gameplay-contract';
export {
  createGameplayCaptureGateway,
  createGameplayCarrierBridge,
  createGameplayOperations,
  executeLiveGameplay,
  registerLiveGameplayBridge,
} from '../io/gameplay-operations';
export type {
  GameplayCaptureGateway,
  GameplayCaptureSurface,
  GameplayCarrierBridge,
  GameplayOperations,
} from '../io/gameplay-operations';
export { createBunGameRuntimePort } from '../product/bun-game-runtime-port';
export type {
  BunGameRuntimePort,
  BunGameRuntimePortOptions,
  BunRuntimeWorld,
} from '../product/bun-game-runtime-port';
