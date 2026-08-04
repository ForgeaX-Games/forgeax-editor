// io/gameplay-contract — the versioned Editor-owned gameplay carrier contract.
//
// This is the only schema authority for gameplay requests, results, errors,
// identity, and capture artifacts. The live producer and future host
// projections consume these schemas instead of maintaining another operation
// union or provenance shape.

import { z } from 'zod';

export const GAMEPLAY_CARRIER_CONTRACT_VERSION = 1 as const;

export const GameplayScopeSchema = z.object({
  projectId: z.string().min(1),
  gameId: z.string().min(1).nullable(),
}).strict();
export type GameplayScope = z.infer<typeof GameplayScopeSchema>;

export const GameplayIdentitySchema = z.object({
  runtimeId: z.string().min(1),
  scope: GameplayScopeSchema,
  pageIdentity: z.string().min(1),
  canvasIdentity: z.string().min(1),
  rendererGeneration: z.number().int().nonnegative(),
}).strict();
export type GameplayIdentity = z.infer<typeof GameplayIdentitySchema>;

export const GameplayKeyInputSchema = z.object({
  type: z.literal('key'),
  key: z.string().min(1),
  phase: z.enum(['down', 'up']),
}).strict();

export const GameplayPointerInputSchema = z.object({
  type: z.literal('pointer'),
  x: z.number().finite(),
  y: z.number().finite(),
  phase: z.enum(['down', 'move', 'up', 'cancel']).optional(),
  pointerId: z.number().int().nonnegative().optional(),
  pointerType: z.enum(['mouse', 'touch', 'pen']).optional(),
  button: z.enum(['left', 'middle', 'right']).optional(),
}).strict();

export const GameplayInputSchema = z.discriminatedUnion('type', [
  GameplayKeyInputSchema,
  GameplayPointerInputSchema,
]);
export type GameplayInput = z.infer<typeof GameplayInputSchema>;

export const GameplayCaptureProvenanceSchema = GameplayIdentitySchema;
export type GameplayCaptureProvenance = GameplayIdentity;

export const GameplayCaptureArtifactSchema = z.object({
  dataUrl: z.string().min(1).startsWith('data:image/png;base64,'),
  bytes: z.number().int().positive(),
  provenance: GameplayCaptureProvenanceSchema,
}).strict();
export type GameplayCaptureArtifact = z.infer<typeof GameplayCaptureArtifactSchema>;

export const GameplayOperationNameSchema = z.enum([
  'describe',
  'input',
  'query',
  'capture',
]);
export type GameplayOperationName = z.infer<typeof GameplayOperationNameSchema>;

export type GameplayOperationManifestEntry = {
  readonly version: typeof GAMEPLAY_CARRIER_CONTRACT_VERSION;
  readonly operation: GameplayOperationName;
};

/** The discoverable operation projection is derived from the contract enum. */
export const GAMEPLAY_OPERATION_MANIFEST: readonly GameplayOperationManifestEntry[] = Object.freeze(
  GameplayOperationNameSchema.options.map((operation) => Object.freeze({
    version: GAMEPLAY_CARRIER_CONTRACT_VERSION,
    operation,
  })),
);

export const GameplayOperationRequestSchema = z.discriminatedUnion('operation', [
  z.object({ version: z.literal(GAMEPLAY_CARRIER_CONTRACT_VERSION), operation: z.literal('describe') }).strict(),
  z.object({ version: z.literal(GAMEPLAY_CARRIER_CONTRACT_VERSION), operation: z.literal('input'), action: GameplayInputSchema }).strict(),
  z.object({ version: z.literal(GAMEPLAY_CARRIER_CONTRACT_VERSION), operation: z.literal('query'), query: z.string() }).strict(),
  z.object({ version: z.literal(GAMEPLAY_CARRIER_CONTRACT_VERSION), operation: z.literal('capture') }).strict(),
]);
export type GameplayOperationRequest = z.infer<typeof GameplayOperationRequestSchema>;

/** Human- and AI-readable help co-owned with the schemas it demonstrates. */
export const GAMEPLAY_CONTRACT_DESCRIPTION = Object.freeze({
  version: GAMEPLAY_CARRIER_CONTRACT_VERSION,
  operations: Object.freeze([
    { operation: 'describe', purpose: 'Read this live contract.', request: { version: 1, operation: 'describe' } },
    { operation: 'query', purpose: 'Read a game-published state projection.', request: { version: 1, operation: 'query', query: '<read-id>' } },
    { operation: 'capture', purpose: 'Capture the authoritative live canvas.', request: { version: 1, operation: 'capture' } },
    { operation: 'input', purpose: 'Send a key transition.', request: { version: 1, operation: 'input', action: { type: 'key', key: 'ArrowLeft', phase: 'down' } } },
    {
      operation: 'input',
      purpose: 'Send pointer transitions as a gesture with one pointerId.',
      requestSequence: [
        { version: 1, operation: 'input', action: { type: 'pointer', x: 120, y: 240, phase: 'down', pointerId: 1, pointerType: 'touch', button: 'left' } },
        { version: 1, operation: 'input', action: { type: 'pointer', x: 320, y: 240, phase: 'up', pointerId: 1, pointerType: 'touch', button: 'left' } },
      ],
    },
  ]),
});

export const GameplayErrorSchema = z.object({
  owner: z.string().min(1),
  code: z.string().min(1),
  phase: z.enum(['contract', 'identity', 'producer', 'capture']),
  retryable: z.boolean(),
  hint: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type GameplayError = z.infer<typeof GameplayErrorSchema>;

const GameplayOperationResultBaseSchema = z.object({
  version: z.literal(GAMEPLAY_CARRIER_CONTRACT_VERSION),
  operation: GameplayOperationNameSchema.nullable(),
});

export const GameplayOperationSuccessSchema = GameplayOperationResultBaseSchema.extend({
  ok: z.literal(true),
  state: z.enum(['running', 'stopped']).optional(),
  data: z.unknown().optional(),
  identity: GameplayIdentitySchema.optional(),
}).strict();

export const GameplayOperationFailureSchema = GameplayOperationResultBaseSchema.extend({
  ok: z.literal(false),
  error: GameplayErrorSchema,
}).strict();

export const GameplayOperationResultSchema = z.union([
  GameplayOperationSuccessSchema,
  GameplayOperationFailureSchema,
]);
export type GameplayOperationResult = z.infer<typeof GameplayOperationResultSchema>;

export type GameplayIdentityDimension =
  | 'runtimeId'
  | 'scope.projectId'
  | 'scope.gameId'
  | 'pageIdentity'
  | 'canvasIdentity'
  | 'rendererGeneration';

export type GameplayIdentityMatch =
  | { matches: true }
  | {
    matches: false;
    dimension: GameplayIdentityDimension;
    expected: string | number | null;
    actual: string | number | null;
  };

/** Compare every carrier identity field and report the first precise mismatch. */
export function sameGameplayIdentity(expected: GameplayIdentity, actual: GameplayIdentity): GameplayIdentityMatch {
  const scalarFields: Array<['runtimeId' | 'pageIdentity' | 'canvasIdentity' | 'rendererGeneration', string | number]> = [
    ['runtimeId', expected.runtimeId],
    ['pageIdentity', expected.pageIdentity],
    ['canvasIdentity', expected.canvasIdentity],
    ['rendererGeneration', expected.rendererGeneration],
  ];
  for (const [field, expectedValue] of scalarFields) {
    const actualValue = actual[field];
    if (actualValue !== expectedValue) return { matches: false, dimension: field, expected: expectedValue, actual: actualValue };
  }
  if (expected.scope.projectId !== actual.scope.projectId) {
    return { matches: false, dimension: 'scope.projectId', expected: expected.scope.projectId, actual: actual.scope.projectId };
  }
  if (expected.scope.gameId !== actual.scope.gameId) {
    return { matches: false, dimension: 'scope.gameId', expected: expected.scope.gameId, actual: actual.scope.gameId };
  }
  return { matches: true };
}
