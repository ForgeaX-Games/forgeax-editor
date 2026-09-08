import type { EditGateway } from './gateway';
import type {
  GameActionDescriptor,
  GameProjectionResult,
  GameProjectionValue,
  GameReadDescriptor,
} from './game-projection';
import {
  GAMEPLAY_CARRIER_CONTRACT_VERSION,
  GAMEPLAY_CONTRACT_DESCRIPTION,
  GameplayCaptureArtifactSchema,
  GameplayCaptureProvenanceSchema,
  GameplayOperationRequestSchema,
  GameplayOperationResultSchema,
  sameGameplayIdentity,
  type GameplayCaptureArtifact,
  type GameplayCaptureProvenance,
  type GameplayError,
  type GameplayIdentity,
  type GameplayInput,
  type GameplayOperationName,
  type GameplayOperationRequest,
  type GameplayOperationResult as GameplayCarrierOperationResult,
} from './gameplay-contract';

export type { GameplayCaptureArtifact, GameplayCaptureProvenance, GameplayInput } from './gameplay-contract';
type GameplayProducerResult = { ok: true; state?: 'running' | 'stopped'; data?: unknown } | { ok: false; error: unknown };
export type GameplayCaptureSurface = {
  /** Capture the composed game viewport, including its viewport-local DOM HUD. */
  captureImage: () => Promise<string>;
  getProvenance: () => GameplayCaptureProvenance | null;
};
export type GameplayCaptureGateway = {
  captureGameplayFrame(): Promise<{ ok: true; value: GameplayCaptureArtifact } | { ok: false; error: unknown }>;
};

function decodedPngBytes(dataUrl: string): number | null {
  const prefix = 'data:image/png;base64,';
  if (!dataUrl.startsWith(prefix)) return null;
  try {
    return globalThis.atob(dataUrl.slice(prefix.length)).length;
  } catch {
    return null;
  }
}

function readSurfaceProvenance(surface: GameplayCaptureSurface): GameplayCaptureProvenance | null {
  const candidate = surface.getProvenance();
  const parsed = GameplayCaptureProvenanceSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function createGameplayCaptureGateway(surface: GameplayCaptureSurface): GameplayCaptureGateway {
  return {
    async captureGameplayFrame() {
      const provenance = readSurfaceProvenance(surface);
      if (!provenance) return { ok: false, error: { code: 'renderer-generation-unavailable', hint: 'live renderer did not publish a numeric generation' } };
      let dataUrl: string;
      try {
        dataUrl = await surface.captureImage();
      } catch (error) {
        return { ok: false, error: { code: 'capture-failed', hint: error instanceof Error ? error.message : String(error) } };
      }
      const bytes = decodedPngBytes(dataUrl);
      if (bytes === null || bytes === 0) return { ok: false, error: { code: 'surface-unavailable', hint: 'live canvas produced no readable PNG artifact' } };
      const artifact = GameplayCaptureArtifactSchema.safeParse({ dataUrl, bytes, provenance });
      if (!artifact.success) return { ok: false, error: { code: 'capture-invalid', hint: 'live canvas produced an invalid gameplay artifact', details: { issues: artifact.error.issues } } };
      return { ok: true, value: artifact.data };
    },
  };
}

export type GameplayGateway = Pick<
  EditGateway,
  'invokeGameAction' | 'readGameState' | 'listGameActions' | 'listGameReads'
> & {
  readonly playPhase: EditGateway['playPhase'];
};

export type RemoteGameplayRequest =
  | { readonly operation: 'describe' }
  | { readonly operation: 'run'; readonly id: string; readonly args: unknown }
  | { readonly operation: 'read'; readonly id: string };

export type RemoteGameplayResult =
  | { readonly ok: true; readonly data?: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly hint: string; readonly retryable?: boolean } };

export interface RemoteGameplayDescriptors {
  readonly actions: readonly GameActionDescriptor[];
  readonly reads: readonly GameReadDescriptor[];
}

export interface RemoteGameplayTransport {
  descriptors(): RemoteGameplayDescriptors;
  request(request: RemoteGameplayRequest): Promise<RemoteGameplayResult>;
}

const REMOTE_READ_ATTEMPTS = 2;

const unavailable = (hint: string): GameplayProducerResult => ({ ok: false, error: { code: 'surface-unavailable', hint } });

export interface GameplayOperations {
  describe(): {
    readonly actions: ReturnType<GameplayGateway['listGameActions']>;
    readonly reads: ReturnType<GameplayGateway['listGameReads']>;
  };
  input(action: GameplayInput): Promise<GameplayProducerResult>;
  query(query: string): Promise<GameplayProducerResult>;
  capture(): Promise<GameplayProducerResult>;
}

export interface GameplayCarrierBridge {
  readonly version: typeof GAMEPLAY_CARRIER_CONTRACT_VERSION;
  execute(request: unknown): Promise<GameplayCarrierOperationResult>;
}

let liveGameplayBridge: GameplayCarrierBridge | undefined;

/** Publish the one bridge owned by the mounted viewport in this Editor realm. */
export function registerLiveGameplayBridge(bridge: GameplayCarrierBridge): () => void {
  liveGameplayBridge = bridge;
  return () => {
    if (liveGameplayBridge === bridge) liveGameplayBridge = undefined;
  };
}

/** Execute through the currently mounted viewport without creating another runtime. */
export function executeLiveGameplay(input: unknown): Promise<GameplayCarrierOperationResult> {
  if (liveGameplayBridge !== undefined) return liveGameplayBridge.execute(input);
  return Promise.resolve(bridgeFailure(null, {
    owner: 'editor-gameplay-carrier',
    code: 'surface-unavailable',
    phase: 'producer',
    retryable: true,
    hint: 'wait for the visible Editor viewport to finish mounting',
  }));
}

function normalizeGameplayError(error: unknown, phase: GameplayError['phase']): GameplayError {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : null;
  const code = typeof record?.code === 'string' && record.code.length > 0 ? record.code : 'operation-failed';
  const hint = typeof record?.hint === 'string' && record.hint.length > 0 ? record.hint : 'retry the gameplay operation';
  const retryable = typeof record?.retryable === 'boolean' ? record.retryable : false;
  const details = record?.details && typeof record.details === 'object' && !Array.isArray(record.details)
    ? record.details as Record<string, unknown>
    : undefined;
  return {
    owner: typeof record?.owner === 'string' && record.owner.length > 0 ? record.owner : 'editor-gameplay-producer',
    code,
    phase,
    retryable,
    hint,
    ...(details ? { details } : {}),
  };
}

function bridgeFailure(operation: GameplayOperationName | null, error: GameplayError): GameplayCarrierOperationResult {
  return { version: GAMEPLAY_CARRIER_CONTRACT_VERSION, operation, ok: false, error };
}

function contractFailure(operation: GameplayOperationName | null, code: string, hint: string, details?: Record<string, unknown>): GameplayCarrierOperationResult {
  return bridgeFailure(operation, {
    owner: 'editor-gameplay-contract', code, phase: 'contract', retryable: false, hint,
    ...(details ? { details } : {}),
  });
}

/**
 * Add a versioned, schema-validated bridge around the live gameplay producer.
 * The bridge accepts unknown wire data, validates it at entry, invokes the
 * producer, validates its result at exit, and fails closed without a complete
 * numeric renderer identity.
 */
export function createGameplayCarrierBridge(
  operations: GameplayOperations,
  getIdentity: () => GameplayIdentity | null,
): GameplayCarrierBridge {
  return {
    version: GAMEPLAY_CARRIER_CONTRACT_VERSION,
    async execute(input) {
      const parsedRequest = GameplayOperationRequestSchema.safeParse(input);
      if (!parsedRequest.success) {
        return contractFailure(null, 'invalid-request', 'send a version 1 gameplay operation request', { issues: parsedRequest.error.issues });
      }
      const request: GameplayOperationRequest = parsedRequest.data;
      if (request.operation === 'describe') {
        return {
          version: GAMEPLAY_CARRIER_CONTRACT_VERSION,
          operation: request.operation,
          ok: true,
          data: {
            ...GAMEPLAY_CONTRACT_DESCRIPTION,
            projections: operations.describe(),
          },
        };
      }
      const before = getIdentity();
      if (!before) {
        return bridgeFailure(request.operation, {
          owner: 'editor-gameplay-carrier',
          code: 'identity-unavailable',
          phase: 'identity',
          retryable: true,
          hint: 'wait for the live carrier to publish a numeric renderer generation',
        });
      }

      let result: GameplayProducerResult;
      try {
        switch (request.operation) {
          case 'input': result = await operations.input(request.action); break;
          case 'query': result = await operations.query(request.query); break;
          case 'capture': result = await operations.capture(); break;
        }
      } catch (error) {
        return bridgeFailure(request.operation, normalizeGameplayError(error, request.operation === 'capture' ? 'capture' : 'producer'));
      }

      if (!result.ok) return bridgeFailure(request.operation, normalizeGameplayError(result.error, request.operation === 'capture' ? 'capture' : 'producer'));
      const after = getIdentity();
      if (!after) {
        return bridgeFailure(request.operation, {
          owner: 'editor-gameplay-carrier', code: 'identity-unavailable', phase: 'identity', retryable: true,
          hint: 'the live renderer generation disappeared during the operation',
        });
      }
      if (request.operation === 'capture' && result.data !== undefined) {
        const artifact = GameplayCaptureArtifactSchema.safeParse(result.data);
        if (!artifact.success) return contractFailure(request.operation, 'invalid-capture-artifact', 'the live producer returned an invalid capture artifact', { issues: artifact.error.issues });
        const match = sameGameplayIdentity(after, artifact.data.provenance);
        if (!match.matches) return bridgeFailure(request.operation, {
          owner: 'editor-gameplay-carrier', code: 'identity-mismatch', phase: 'identity', retryable: true,
          hint: 'capture again after the live renderer is stable', details: match,
        });
      }
      const output = {
        version: GAMEPLAY_CARRIER_CONTRACT_VERSION,
        operation: request.operation,
        ok: true as const,
        ...(result.state ? { state: result.state } : {}),
        ...(result.data !== undefined ? { data: result.data } : {}),
        identity: after,
      };
      const parsedResult = GameplayOperationResultSchema.safeParse(output);
      if (!parsedResult.success) return contractFailure(request.operation, 'invalid-producer-result', 'the live producer returned data outside the gameplay contract', { issues: parsedResult.error.issues });
      return parsedResult.data;
    },
  };
}

/** The typed producer for the already-connected live Gateway projection. */
export function createGameplayOperations(gateway: GameplayGateway, capture?: GameplayCaptureGateway): GameplayOperations {
  return {
    describe: () => ({
      actions: gateway.listGameActions(),
      reads: gateway.listGameReads(),
    }),
    async input(action) {
      if (gateway.playPhase !== 'play') return unavailable('input requires an active live Play projection');
      const result = await gateway.invokeGameAction('input', action);
      if (!result.ok) return result;
      return result.value === undefined ? { ok: true } : { ok: true, data: result.value };
    },
    async query(query) {
      if (gateway.playPhase !== 'play') return unavailable('query requires an active live Play projection');
      const result = await gateway.readGameState(query.trim() || 'world');
      return result.ok ? { ok: true, data: result.value } : result;
    },
    async capture() {
      if (gateway.playPhase !== 'play') return unavailable('capture requires an active live Play projection');
      if (!capture) return unavailable('capture requires a live canvas capture surface');
      const result = await capture.captureGameplayFrame();
      return result.ok ? { ok: true, data: result.value } : result;
    },
  };
}

/** Adapt a disposable iframe's projection RPC to the normal Gateway-shaped producer. */
export function createRemoteGameplayGateway(
  transport: RemoteGameplayTransport,
  getPlayPhase: () => EditGateway['playPhase'],
): GameplayGateway {
  const unavailableResult = <T>(): GameProjectionResult<T> => ({
    ok: false,
    error: {
      code: 'game-projection-unavailable',
      hint: 'game projections are available only while the remote Play carrier is active',
    },
  });
  const remoteFailure = <T>(result: RemoteGameplayResult): GameProjectionResult<T> => {
    if (result.ok) return { ok: true, value: result.data as T };
    return {
      ok: false,
      error: {
        code: result.error.code as never,
        hint: result.error.hint,
      },
    };
  };
  const readRemoteGameplay = async (id: string): Promise<RemoteGameplayResult> => {
    let result: RemoteGameplayResult = {
      ok: false,
      error: {
        code: 'game-projection-unavailable',
        hint: 'remote Play did not answer the gameplay projection request',
        retryable: true,
      },
    };
    for (let attempt = 0; attempt < REMOTE_READ_ATTEMPTS; attempt += 1) {
      result = await transport.request({ operation: 'read', id });
      if (result.ok || result.error.retryable !== true || getPlayPhase() !== 'play') return result;
    }
    return result;
  };
  return {
    get playPhase() { return getPlayPhase(); },
    listGameActions: () => transport.descriptors().actions,
    listGameReads: () => transport.descriptors().reads,
    invokeGameAction: async (id, args) => {
      if (getPlayPhase() !== 'play') return unavailableResult();
      return remoteFailure<GameProjectionValue | undefined>(await transport.request({ operation: 'run', id, args }));
    },
    readGameState: async (id) => {
      if (getPlayPhase() !== 'play') return unavailableResult();
      return remoteFailure<GameProjectionValue>(await readRemoteGameplay(id));
    },
  };
}
