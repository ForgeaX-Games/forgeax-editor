import {
  createRuntimeAvailability,
  createStaleRuntimeHandleError,
  runtimeError,
  unavailableRuntimeError,
  type GameRuntimePort,
  type RuntimeAvailability,
  type RuntimeEntityHandle,
  type RuntimeCapability,
  type RuntimeOperation,
  type RuntimeResult,
  type RuntimeWorldHandle,
} from '@forgeax/editor-product';
import type { RunLifecycle } from '../viewport/run-lifecycle';

export interface BrowserGameRuntimePortOptions {
  readonly lifecycle: Pick<RunLifecycle, 'playSimulation' | 'stopSimulation' | 'dispose' | 'currentPlayWorld' | 'getPlayPauseHandle' | 'currentPlayRunId'>;
  readonly query?: (world: unknown, query: string | RuntimeEntityHandle | undefined) => unknown | Promise<unknown>;
  readonly fixedStep?: (world: unknown, deltaMs: number) => void | Promise<void>;
  readonly capture?: (world: unknown) => unknown | Promise<unknown>;
  readonly reveal?: (world: unknown, artifact: unknown) => void | Promise<void>;
  readonly availability?: Partial<RuntimeAvailability>;
}

export interface BrowserGameRuntimePort extends GameRuntimePort {
  readonly availability: () => BrowserRuntimeAvailability;
  readonly currentWorld: () => unknown | null;
  readonly currentWorldId: () => string | null;
}

export type BrowserRuntimeAvailability = RuntimeAvailability & {
  readonly capabilities: Readonly<Record<RuntimeOperation, RuntimeCapability>>;
};

function failure(code: string, hint: string, recoveryActions: readonly string[] = []): RuntimeResult<never> {
  return { ok: false, error: runtimeError(code, hint, { recoveryActions }) };
}

function normalizeResult<T>(value: unknown): RuntimeResult<T> {
  if (value !== null && typeof value === 'object' && 'ok' in value) {
    const candidate = value as { readonly ok?: unknown };
    if (candidate.ok === true || candidate.ok === false) return value as RuntimeResult<T>;
  }
  return { ok: true, value: value as T };
}

export function createBrowserGameRuntimePort(options: BrowserGameRuntimePortOptions): BrowserGameRuntimePort {
  let activeWorld: unknown | null = null;
  let activeWorldId: string | null = null;
  let worldSequence = 0;
  let disposed = false;
  const availability = createRuntimeAvailability({
    host: 'browser',
    blocking: false,
    capabilities: {
      play: { available: true },
      stop: { available: true },
      query: { available: true },
      fixedStep: options.fixedStep === undefined
        ? { available: false, code: 'display-unavailable', reason: 'browser runtime does not expose a fixed-step hook' }
        : { available: true },
      dispose: { available: true },
      capture: options.capture === undefined
        ? { available: false, code: 'display-unavailable', reason: 'browser runtime capture is not configured' }
        : { available: true },
      reveal: options.reveal === undefined
        ? { available: false, code: 'display-unavailable', reason: 'browser runtime reveal is not configured' }
        : { available: true },
    },
  }) as BrowserRuntimeAvailability;

  async function play(): Promise<RuntimeResult<RuntimeWorldHandle>> {
    if (disposed) return failure('runtime-disposed', 'the browser runtime has been disposed', ['runtime.create']);
    if (activeWorld !== null && activeWorldId !== null) return { ok: true, value: { worldId: activeWorldId } };
    try {
      await options.lifecycle.playSimulation();
      const world = options.lifecycle.currentPlayWorld();
      if (world === null || world === undefined) return failure('runtime-start-failed', 'Play lifecycle did not expose a play world', ['runtime.play']);
      activeWorld = world;
      activeWorldId = `browser-play-${++worldSequence}`;
      return { ok: true, value: { worldId: activeWorldId } };
    } catch (cause) {
      return failure('runtime-start-failed', cause instanceof Error ? cause.message : 'browser play world creation failed', ['runtime.play']);
    }
  }

  async function stop(): Promise<RuntimeResult<void>> {
    try {
      await options.lifecycle.stopSimulation();
      activeWorld = null;
      activeWorldId = null;
      return { ok: true, value: undefined };
    } catch (cause) {
      return failure('runtime-stop-failed', cause instanceof Error ? cause.message : 'browser play world disposal failed', ['runtime.stop']);
    }
  }

  async function query(queryInput?: string | RuntimeEntityHandle): Promise<RuntimeResult<unknown>> {
    const world = activeWorld;
    const worldId = activeWorldId;
    if (world === null || worldId === null) {
      if (options.query === undefined) return failure('runtime-not-running', 'query requires an active play world', ['runtime.play']);
      try {
        return normalizeResult(await options.query(world, queryInput));
      } catch (cause) {
        return failure('runtime-query-failed', cause instanceof Error ? cause.message : 'browser runtime query failed', ['runtime.query']);
      }
    }
    if (typeof queryInput === 'object' && queryInput !== null && queryInput.worldId !== worldId) {
      return { ok: false, error: createStaleRuntimeHandleError({ expectedWorldId: worldId, actualWorldId: queryInput.worldId, handleId: queryInput.entityId }) };
    }
    try {
      return normalizeResult(await options.query?.(world, queryInput) ?? world);
    } catch (cause) {
      return failure('runtime-query-failed', cause instanceof Error ? cause.message : 'browser runtime query failed', ['runtime.query']);
    }
  }

  async function fixedStep(deltaMs: number): Promise<RuntimeResult<void>> {
    const world = activeWorld;
    if (world === null) return failure('runtime-not-running', 'fixedStep requires an active play world', ['runtime.play']);
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return failure('runtime-invalid-step', 'fixedStep deltaMs must be a positive finite number');
    if (options.fixedStep === undefined) return { ok: false, error: unavailableRuntimeError('fixedStep', 'browser runtime does not expose a fixed-step hook') };
    try {
      await options.fixedStep(world, deltaMs);
      return { ok: true, value: undefined };
    } catch (cause) {
      return failure('runtime-step-failed', cause instanceof Error ? cause.message : 'browser fixed-step simulation failed', ['runtime.fixedStep']);
    }
  }

  async function dispose(): Promise<RuntimeResult<void>> {
    const result = await stop();
    try {
      options.lifecycle.dispose();
      disposed = true;
      return result;
    } catch (cause) {
      return failure('runtime-dispose-failed', cause instanceof Error ? cause.message : 'browser runtime disposal failed', ['runtime.dispose']);
    }
  }

  return {
    availability: () => options.availability === undefined ? availability : Object.freeze({ ...availability, ...options.availability }) as BrowserRuntimeAvailability,
    play,
    stop,
    query,
    fixedStep,
    dispose,
    async capture() {
      if (activeWorld === null || options.capture === undefined) return { ok: false, error: unavailableRuntimeError('capture', 'browser runtime capture is unavailable') };
      return normalizeResult(await options.capture(activeWorld));
    },
    async reveal(artifact: unknown) {
      if (activeWorld === null || options.reveal === undefined) return { ok: false, error: unavailableRuntimeError('reveal', 'browser runtime reveal is unavailable') };
      await options.reveal(activeWorld, artifact);
      return { ok: true, value: undefined };
    },
    currentWorld: () => activeWorld,
    currentWorldId: () => activeWorldId,
  };
}
