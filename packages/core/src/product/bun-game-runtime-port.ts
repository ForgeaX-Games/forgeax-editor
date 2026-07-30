import {
  createRuntimeAvailability,
  createStaleRuntimeHandleError,
  runtimeError,
  unavailableRuntimeError,
  type GameRuntimePort,
  type RuntimeAvailability,
  type RuntimeEntityHandle,
  type RuntimeResult,
} from '@forgeax/editor-product';

export interface BunRuntimeWorld {
  readonly worldId: string;
  readonly entities?: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface BunGameRuntimePortOptions {
  readonly createPlayWorld: () => BunRuntimeWorld | Promise<BunRuntimeWorld>;
  readonly disposePlayWorld?: (world: BunRuntimeWorld) => void | Promise<void>;
  readonly query?: (world: BunRuntimeWorld, query: string | RuntimeEntityHandle | undefined) => unknown | Promise<unknown>;
  readonly fixedStep?: (world: BunRuntimeWorld, deltaMs: number) => void | Promise<void>;
  readonly authoredSnapshot?: () => unknown;
  readonly availability?: Partial<RuntimeAvailability>;
}

export interface BunGameRuntimePort extends GameRuntimePort {
  readonly authoredSnapshot: () => unknown;
  readonly currentWorld: () => BunRuntimeWorld | null;
}

const displayUnavailable = {
  available: false as const,
  code: 'display-unavailable',
  reason: 'Bun fixed-step runtime has no display surface.',
};

function failure(code: string, hint: string, recoveryActions: readonly string[] = []): RuntimeResult<never> {
  return { ok: false, error: runtimeError(code, hint, { recoveryActions }) };
}

export function createBunGameRuntimePort(options: BunGameRuntimePortOptions): BunGameRuntimePort {
  let activeWorld: BunRuntimeWorld | null = null;
  let disposed = false;
  const availability = createRuntimeAvailability({
    host: 'bun',
    blocking: false,
    capabilities: {
      play: { available: true },
      stop: { available: true },
      query: { available: true },
      fixedStep: { available: true },
      dispose: { available: true },
      capture: displayUnavailable,
      reveal: displayUnavailable,
    },
  });

  async function play(): Promise<RuntimeResult<{ worldId: string }>> {
    if (disposed) return failure('runtime-disposed', 'the Bun runtime has been disposed', ['runtime.create']);
    if (activeWorld !== null) return { ok: true, value: { worldId: activeWorld.worldId } };
    try {
      const world = await options.createPlayWorld();
      if (!world || typeof world.worldId !== 'string' || world.worldId.length === 0) return failure('runtime-invalid-world', 'play world factory returned no stable world id', ['runtime.create']);
      activeWorld = world;
      return { ok: true, value: { worldId: world.worldId } };
    } catch (cause) {
      return failure('runtime-start-failed', cause instanceof Error ? cause.message : 'play world creation failed', ['runtime.play']);
    }
  }

  async function stop(): Promise<RuntimeResult<void>> {
    const world = activeWorld;
    activeWorld = null;
    if (world === null) return { ok: true, value: undefined };
    try {
      await options.disposePlayWorld?.(world);
      return { ok: true, value: undefined };
    } catch (cause) {
      return failure('runtime-stop-failed', cause instanceof Error ? cause.message : 'play world disposal failed', ['runtime.stop']);
    }
  }

  async function query(queryInput?: string | RuntimeEntityHandle): Promise<RuntimeResult<unknown>> {
    const world = activeWorld;
    if (world === null) return failure('runtime-not-running', 'query requires an active play world', ['runtime.play']);
    if (typeof queryInput === 'object' && queryInput !== null && queryInput.worldId !== world.worldId) return { ok: false, error: createStaleRuntimeHandleError({ expectedWorldId: world.worldId, actualWorldId: queryInput.worldId, handleId: queryInput.entityId }) };
    try {
      return { ok: true, value: options.query === undefined ? world : await options.query(world, queryInput) };
    } catch (cause) {
      return failure('runtime-query-failed', cause instanceof Error ? cause.message : 'runtime query failed', ['runtime.query']);
    }
  }

  async function fixedStep(deltaMs: number): Promise<RuntimeResult<void>> {
    const world = activeWorld;
    if (world === null) return failure('runtime-not-running', 'fixedStep requires an active play world', ['runtime.play']);
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return failure('runtime-invalid-step', 'fixedStep deltaMs must be a positive finite number');
    try {
      await options.fixedStep?.(world, deltaMs);
      return { ok: true, value: undefined };
    } catch (cause) {
      return failure('runtime-step-failed', cause instanceof Error ? cause.message : 'fixed-step simulation failed', ['runtime.fixedStep']);
    }
  }

  async function dispose(): Promise<RuntimeResult<void>> {
    const result = await stop();
    disposed = true;
    return result;
  }

  return {
    availability: () => options.availability === undefined ? availability : Object.freeze({ ...availability, ...options.availability }),
    play,
    stop,
    query,
    fixedStep,
    dispose,
    async capture() { return { ok: false, error: unavailableRuntimeError('capture', 'Bun fixed-step runtime has no display surface.') }; },
    async reveal() { return { ok: false, error: unavailableRuntimeError('reveal', 'Bun fixed-step runtime has no focusable display surface.') }; },
    authoredSnapshot: () => options.authoredSnapshot?.(),
    currentWorld: () => activeWorld,
  };
}
