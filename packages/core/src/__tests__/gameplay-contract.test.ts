import { describe, expect, test } from 'bun:test';
import {
  GAMEPLAY_OPERATION_MANIFEST,
  GameplayCaptureArtifactSchema,
  GameplayCaptureProvenanceSchema,
  GameplayIdentitySchema,
  GameplayOperationNameSchema,
  GameplayOperationRequestSchema,
  GameplayOperationResultSchema,
  sameGameplayIdentity,
} from '../io/gameplay-contract';

const identity = {
  runtimeId: 'runtime-1',
  scope: { projectId: 'project-1', gameId: 'game-1' },
  pageIdentity: 'page-1',
  canvasIdentity: 'canvas-1',
  rendererGeneration: 3,
} as const;

describe('versioned gameplay carrier contract', () => {
  test('accepts all operation request shapes and rejects unknown versions or fields', () => {
    const requests = [
      { version: 1, operation: 'play' },
      { version: 1, operation: 'gameplayStop' },
      { version: 1, operation: 'input', action: { type: 'key', key: 'ArrowRight', phase: 'down' } },
      { version: 1, operation: 'query', query: 'input.status' },
      { version: 1, operation: 'capture' },
      { version: 1, operation: 'reveal', artifact: { dataUrl: 'data:image/png;base64,frame', bytes: 28, provenance: identity } },
    ];
    for (const request of requests) expect(GameplayOperationRequestSchema.safeParse(request).success).toBe(true);
    expect(GameplayOperationRequestSchema.safeParse({ version: 2, operation: 'play' }).success).toBe(false);
    expect(GameplayOperationRequestSchema.safeParse({ version: 1, operation: 'play', extra: true }).success).toBe(false);
  });

  test('validates identity and capture provenance as one typed shape', () => {
    expect(GameplayIdentitySchema.safeParse(identity).success).toBe(true);
    expect(GameplayCaptureProvenanceSchema.safeParse(identity).success).toBe(true);
    expect(GameplayCaptureProvenanceSchema.safeParse({ ...identity, scope: undefined }).success).toBe(false);
    expect(GameplayCaptureArtifactSchema.safeParse({ dataUrl: 'data:image/png;base64,frame', bytes: 28, provenance: identity }).success).toBe(true);
    expect(GameplayCaptureArtifactSchema.safeParse({ dataUrl: '', bytes: 0, provenance: identity }).success).toBe(false);
  });

  test('derives the public operation manifest from the contract enum', () => {
    expect(GAMEPLAY_OPERATION_MANIFEST.map((entry) => entry.operation)).toEqual(GameplayOperationNameSchema.options);
    expect(GAMEPLAY_OPERATION_MANIFEST.every((entry) => entry.version === 1)).toBe(true);
  });

  test('reports explicit identity mismatch dimensions without stringifying fields', () => {
    expect(sameGameplayIdentity(identity, identity)).toEqual({ matches: true });
    expect(sameGameplayIdentity(identity, { ...identity, scope: { ...identity.scope, gameId: 'other-game' } }))
      .toEqual({ matches: false, dimension: 'scope.gameId', expected: 'game-1', actual: 'other-game' });
    expect(sameGameplayIdentity(identity, { ...identity, rendererGeneration: 4 }))
      .toEqual({ matches: false, dimension: 'rendererGeneration', expected: 3, actual: 4 });
  });

  test('validates success and typed failure envelopes', () => {
    expect(GameplayOperationResultSchema.safeParse({
      version: 1, operation: 'play', ok: true, state: 'running', identity,
    }).success).toBe(true);
    expect(GameplayOperationResultSchema.safeParse({
      version: 1,
      operation: 'capture',
      ok: false,
      error: {
        owner: 'editor-gameplay-carrier', code: 'identity-mismatch', phase: 'identity', retryable: true,
        hint: 'capture again', details: { dimension: 'canvasIdentity' },
      },
    }).success).toBe(true);
  });
});
