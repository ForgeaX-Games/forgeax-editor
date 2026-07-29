import type { EditGateway, DispatchResult } from './gateway';

export type GameplayInput = { type: 'key'; key: string; phase: 'down' | 'up' } | { type: 'pointer'; x: number; y: number; button?: 'left' | 'middle' | 'right' };
export type GameplayCaptureProvenance = { runtimeId: string; pageIdentity: string; canvasIdentity: string; rendererGeneration: number };
export type GameplayCaptureArtifact = { dataUrl: string; bytes: number; provenance: GameplayCaptureProvenance };
export type GameplayOperationResult = { ok: true; state?: 'running' | 'stopped'; data?: unknown } | { ok: false; error: unknown };
export type GameplayCaptureSurface = { canvas: HTMLCanvasElement; provenance: GameplayCaptureProvenance; focus: () => void };
export type GameplayCaptureGateway = {
  captureGameplayFrame(): { ok: true; value: GameplayCaptureArtifact } | { ok: false; error: unknown };
  revealGameplayFrame(artifact: GameplayCaptureArtifact): { ok: true } | { ok: false; error: unknown };
};

export function createGameplayCaptureGateway(surface: GameplayCaptureSurface): GameplayCaptureGateway {
  return {
    captureGameplayFrame() {
      const dataUrl = surface.canvas.toDataURL('image/png');
      if (!dataUrl || !dataUrl.startsWith('data:image/')) return { ok: false, error: { code: 'surface-unavailable', hint: 'live canvas produced no readable artifact' } };
      return { ok: true, value: { dataUrl, bytes: dataUrl.length, provenance: { ...surface.provenance } } };
    },
    revealGameplayFrame(artifact) {
      if (JSON.stringify(artifact.provenance) !== JSON.stringify(surface.provenance)) return { ok: false, error: { code: 'identity-mismatch', hint: 'capture again' } };
      surface.focus();
      return { ok: true };
    },
  };
}

type GameplayGateway = Pick<EditGateway, 'dispatch' | 'invokeGameAction' | 'readGameState'> & { readonly playPhase: EditGateway['playPhase'] };

const unavailable = (hint: string): GameplayOperationResult => ({ ok: false, error: { code: 'surface-unavailable', hint } });

function dispatchResult(result: DispatchResult): GameplayOperationResult {
  return result.ok ? { ok: true } : result;
}

export interface GameplayOperations {
  play(): Promise<GameplayOperationResult>;
  gameplayStop(): Promise<GameplayOperationResult>;
  input(action: GameplayInput): Promise<GameplayOperationResult>;
  query(query: string): Promise<GameplayOperationResult>;
  capture(): Promise<GameplayOperationResult>;
  reveal(artifact: GameplayCaptureArtifact): Promise<GameplayOperationResult>;
}

/** The typed producer for the already-connected live Gateway projection. */
export function createGameplayOperations(gateway: GameplayGateway, capture?: GameplayCaptureGateway): GameplayOperations {
  return {
    async play() {
      if (gateway.playPhase === 'play') return { ok: true, state: 'running' };
      return dispatchResult(gateway.dispatch({ kind: 'play' }));
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
