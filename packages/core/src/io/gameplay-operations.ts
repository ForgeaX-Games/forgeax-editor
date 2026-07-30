import type { EditGateway, DispatchResult } from './gateway';
import {
  GAMEPLAY_CARRIER_CONTRACT_VERSION,
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
  canvas: HTMLCanvasElement;
  getProvenance: () => GameplayCaptureProvenance | null;
  focus: () => void;
};
export type GameplayCaptureGateway = {
  captureGameplayFrame(): { ok: true; value: GameplayCaptureArtifact } | { ok: false; error: unknown };
  revealGameplayFrame(artifact: GameplayCaptureArtifact): { ok: true } | { ok: false; error: unknown };
};

function readSurfaceProvenance(surface: GameplayCaptureSurface): GameplayCaptureProvenance | null {
  const candidate = surface.getProvenance();
  const parsed = GameplayCaptureProvenanceSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function createGameplayCaptureGateway(surface: GameplayCaptureSurface): GameplayCaptureGateway {
  return {
    captureGameplayFrame() {
      const provenance = readSurfaceProvenance(surface);
      if (!provenance) return { ok: false, error: { code: 'renderer-generation-unavailable', hint: 'live renderer did not publish a numeric generation' } };
      let dataUrl: string;
      try {
        dataUrl = surface.canvas.toDataURL('image/png');
      } catch (error) {
        return { ok: false, error: { code: 'capture-failed', hint: error instanceof Error ? error.message : String(error) } };
      }
      if (!dataUrl || !dataUrl.startsWith('data:image/')) return { ok: false, error: { code: 'surface-unavailable', hint: 'live canvas produced no readable artifact' } };
      const artifact = GameplayCaptureArtifactSchema.safeParse({ dataUrl, bytes: dataUrl.length, provenance });
      if (!artifact.success) return { ok: false, error: { code: 'capture-invalid', hint: 'live canvas produced an invalid gameplay artifact', details: { issues: artifact.error.issues } } };
      return { ok: true, value: artifact.data };
    },
    revealGameplayFrame(artifact) {
      const parsedArtifact = GameplayCaptureArtifactSchema.safeParse(artifact);
      if (!parsedArtifact.success) return { ok: false, error: { code: 'invalid-capture-artifact', hint: 'capture a fresh valid gameplay artifact', details: { issues: parsedArtifact.error.issues } } };
      const current = readSurfaceProvenance(surface);
      if (!current) return { ok: false, error: { code: 'renderer-generation-unavailable', hint: 'live renderer did not publish a numeric generation' } };
      const match = sameGameplayIdentity(current, parsedArtifact.data.provenance);
      if (!match.matches) return { ok: false, error: { code: 'identity-mismatch', hint: 'capture again', details: match } };
      try {
        surface.focus();
      } catch (error) {
        return { ok: false, error: { code: 'reveal-failed', hint: error instanceof Error ? error.message : String(error) } };
      }
      return { ok: true };
    },
  };
}

type GameplayGateway = Pick<EditGateway, 'dispatch' | 'invokeGameAction' | 'readGameState'> & {
  readonly playPhase: EditGateway['playPhase'];
  readonly lastPlayError?: { code?: unknown; hint?: unknown } | null;
};

const PLAY_READY_TIMEOUT_MS = 15_000;

const unavailable = (hint: string): GameplayProducerResult => ({ ok: false, error: { code: 'surface-unavailable', hint } });

function dispatchResult(result: DispatchResult): GameplayProducerResult {
  return result.ok ? { ok: true } : result;
}

async function waitForPlayTerminal(gateway: GameplayGateway): Promise<GameplayProducerResult> {
  const deadline = Date.now() + PLAY_READY_TIMEOUT_MS;
  while (gateway.playPhase === 'starting' && Date.now() < deadline) {
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 25));
  }
  if (gateway.playPhase === 'play') return { ok: true, state: 'running' };
  const failure = gateway.lastPlayError;
  return {
    ok: false,
    error: {
      code: typeof failure?.code === 'string' && failure.code.length > 0 ? failure.code : 'play-not-ready',
      hint: typeof failure?.hint === 'string' && failure.hint.length > 0
        ? failure.hint
        : 'the live Play projection did not become ready before the bounded wait expired',
    },
  };
}

export interface GameplayOperations {
  play(): Promise<GameplayProducerResult>;
  gameplayStop(): Promise<GameplayProducerResult>;
  input(action: GameplayInput): Promise<GameplayProducerResult>;
  query(query: string): Promise<GameplayProducerResult>;
  capture(): Promise<GameplayProducerResult>;
  reveal(artifact: GameplayCaptureArtifact): Promise<GameplayProducerResult>;
}

export interface GameplayCarrierBridge {
  readonly version: typeof GAMEPLAY_CARRIER_CONTRACT_VERSION;
  execute(request: unknown): Promise<GameplayCarrierOperationResult>;
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
          case 'play': result = await operations.play(); break;
          case 'gameplayStop': result = await operations.gameplayStop(); break;
          case 'input': result = await operations.input(request.action); break;
          case 'query': result = await operations.query(request.query); break;
          case 'capture': result = await operations.capture(); break;
          case 'reveal': result = await operations.reveal(request.artifact); break;
        }
      } catch (error) {
        return bridgeFailure(request.operation, normalizeGameplayError(error, request.operation === 'capture' ? 'capture' : request.operation === 'reveal' ? 'reveal' : 'producer'));
      }

      if (!result.ok) return bridgeFailure(request.operation, normalizeGameplayError(result.error, request.operation === 'capture' ? 'capture' : request.operation === 'reveal' ? 'reveal' : 'producer'));
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
    async play() {
      if (gateway.playPhase === 'play') return { ok: true, state: 'running' };
      const dispatched = dispatchResult(gateway.dispatch({ kind: 'play' }));
      return dispatched.ok ? waitForPlayTerminal(gateway) : dispatched;
    },
    async gameplayStop() {
      if (gateway.playPhase !== 'play') return { ok: true, state: 'stopped' };
      const result = dispatchResult(gateway.dispatch({ kind: 'stop' }));
      return result.ok ? { ok: true, state: 'stopped' } : result;
    },
    async input(action) {
      if (gateway.playPhase !== 'play') return unavailable('input requires an active live Play projection');
      const result = await gateway.invokeGameAction('input', action);
      return result.ok ? { ok: true } : result;
    },
    async query(query) {
      if (gateway.playPhase !== 'play') return unavailable('query requires an active live Play projection');
      const result = await gateway.readGameState(query.trim() || 'world');
      return result.ok ? { ok: true, data: result.value } : result;
    },
    async capture() {
      if (gateway.playPhase !== 'play') return unavailable('capture requires an active live Play projection');
      if (!capture) return unavailable('capture requires a live canvas capture surface');
      const result = capture.captureGameplayFrame();
      return result.ok ? { ok: true, data: result.value } : result;
    },
    async reveal(artifact) {
      if (gateway.playPhase !== 'play') return unavailable('reveal requires an active live Play projection');
      if (!capture) return unavailable('reveal requires a live canvas capture surface');
      const result = capture.revealGameplayFrame(artifact);
      return result.ok ? { ok: true } : result;
    },
  };
}
