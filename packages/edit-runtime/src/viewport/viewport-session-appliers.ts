// viewport-session-appliers — the edit-runtime registration seam for viewport
// lifecycle/control operations (M3).
//
// The registrar is deliberately framework-free: it imports no React, DOM, or
// component state. ViewportComponent supplies closures over the already-created
// runtime, and teardown owns the returned disposer. Domain is structural because
// every operation is registered into core's session-applier table.

import { getRegisteredSystems, Update } from '@forgeax/engine-ecs';
import type { World } from '@forgeax/engine-ecs';
import {
  ParticleEffectPlayer,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuRuntime,
} from '@forgeax/engine-vfx';
import { registerSessionApplier, restoreAllAnimationPreviews, type DispatchResult, type PlayDirtyPolicy, type SessionApplier } from '@forgeax/editor-core';

export interface ViewportSessionApplierDeps {
  readonly play: (policy: PlayDirtyPolicy, origin: 'human' | 'ai') => DispatchResult;
  readonly stop: () => void;
  readonly setDisplay: (display: 'scene' | 'game') => void;
  readonly grantGameControl: () => void;
  readonly releaseGameControl: () => void;
  /** Optional engine RHI debug capture, injected by the runtime owner. */
  readonly captureFrame?: (frames: number) => Promise<unknown>;
  /** Outer lifecycle deadline; injectable so the terminal-state contract is deterministic in tests. */
  readonly captureTimeoutMs?: number;
  readonly world: World;
  /** Late-bound because Play swaps the Gateway active World. */
  readonly activeWorld: () => World;
}

const DEFAULT_CAPTURE_TIMEOUT_MS = 60_000;

const invalidArgs = (hint: string) => ({ ok: false as const, error: { code: 'INVALID_ARGS' as const, hint } });

function rhiCaptureFailure(error: unknown) {
  const candidate = error !== null && typeof error === 'object'
    ? error as { code?: unknown; expected?: unknown; detail?: unknown; hint?: unknown }
    : undefined;
  const sourceCode = typeof candidate?.code === 'string' ? candidate.code : 'exception';
  const sourceHint = typeof candidate?.hint === 'string'
    ? candidate.hint
    : error instanceof Error ? error.message : String(error);
  const terminalCode = sourceCode === 'capture-disk-space-insufficient'
    || sourceCode === 'capture-artifact-write-failed'
    || sourceCode === 'capture-timeout'
    || sourceCode === 'capture-cancelled'
    ? sourceCode
    : 'rhi-capture-failed';
  const details = {
    ...(candidate?.expected === undefined ? {} : { expected: candidate.expected }),
    ...(candidate?.detail === undefined ? {} : { detail: candidate.detail }),
  };
  return {
    ok: false as const,
    error: {
      code: terminalCode,
      owner: 'engine',
      category: 'runtime',
      hint: sourceHint,
      retryable: true,
      recoveryActions: terminalCode === 'capture-artifact-write-failed'
        ? ['capture.cleanup', 'capture.retry']
        : ['capture.retry'],
      cause: {
        code: sourceCode,
        owner: 'engine',
        hint: sourceHint,
        ...(Object.keys(details).length === 0 ? {} : { details }),
      },
    },
  };
}

function captureWithDeadline(capture: () => Promise<unknown>, timeoutMs: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject({
      code: 'capture-timeout',
      expected: `captureFrame completes within ${timeoutMs} ms`,
      hint: `RHI capture did not complete within ${timeoutMs} ms`,
      detail: { timeoutMs, stage: 'capture' },
    }), timeoutMs);
  });
  return Promise.race([Promise.resolve().then(capture), deadline])
    .finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

function registerAll(deps: ViewportSessionApplierDeps): Array<() => void> {
  const disposers: Array<() => void> = [];
  const register = (kind: string, applier: SessionApplier, title: string, argsSchema?: unknown): void => {
    disposers.push(registerSessionApplier(kind, applier, { title, ...(argsSchema === undefined ? {} : { argsSchema }) }));
  };

  try {
    register('play', (op, ctx) => {
      const dirtyPolicy = (op as { dirtyPolicy?: unknown }).dirtyPolicy ?? 'last-saved';
      if (dirtyPolicy !== 'last-saved' && dirtyPolicy !== 'save-then-play' && dirtyPolicy !== 'cancel') {
        return invalidArgs('dirtyPolicy must be "last-saved", "save-then-play", or "cancel"');
      }
      // Animation-preview defense (M1): entering Play forks/simulates the edit
      // world — restore preview-touched runtime fields first so the simulation
      // (and any save-then-play) starts from authored values.
      if (ctx?.engine) restoreAllAnimationPreviews(ctx.engine);
      return deps.play(dirtyPolicy, ctx?.origin ?? 'human');
    }, 'Play', {
      type: 'object',
      properties: {
        dirtyPolicy: { type: 'string', enum: ['last-saved', 'save-then-play', 'cancel'] },
      },
    });
    register('stop', () => { deps.stop(); return { ok: true }; }, 'Stop');
    register('setDisplay', (op) => {
      const display = (op as { display?: unknown }).display;
      if (display !== 'scene' && display !== 'game') return invalidArgs('display must be "scene" or "game"');
      deps.setDisplay(display);
      return { ok: true };
    }, 'Set Viewport Display', {
      type: 'object', properties: { display: { type: 'string', enum: ['scene', 'game'] } }, required: ['display'],
    });
    register('grantGameControl', () => { deps.grantGameControl(); return { ok: true }; }, 'Grant Game Control');
    register('releaseGameControl', () => { deps.releaseGameControl(); return { ok: true }; }, 'Release Game Control');
    register('captureFrame', (op, ctx) => {
      const request = op as { frames?: unknown };
      const frames = request.frames === undefined ? 1 : request.frames;
      if (typeof frames !== 'number' || !Number.isInteger(frames) || frames < 1 || frames > 8) {
        return invalidArgs('frames must be an integer between 1 and 8');
      }
      if (deps.captureFrame === undefined) {
        return {
          ok: false as const,
          error: {
            code: 'rhi-debug-unavailable' as const,
            hint: 'Start the editor with --rhi-debug before dispatching captureFrame',
            retryable: true,
            recoveryActions: ['capture.retry'],
          },
        };
      }
      const timeoutMs = deps.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
      ctx?.operationRun?.reportProgress({ fraction: 0.05, stage: 'capturing' });
      const completion = captureWithDeadline(() => deps.captureFrame!(frames), timeoutMs).catch(rhiCaptureFailure);
      return { ok: true as const, completion };
    }, 'Capture RHI Frame', {
      type: 'object',
      properties: { frames: { type: 'number', minimum: 1, maximum: 8 } },
    });
    register('replayParticleEffect', (op) => {
      const entity = (op as { entity?: unknown }).entity;
      if (typeof entity !== 'number' || !Number.isSafeInteger(entity) || entity < 0) {
        return invalidArgs('entity must be a live non-negative entity handle');
      }
      const world = deps.activeWorld();
      const player = world.get(entity as never, ParticleEffectPlayer);
      if (!player.ok) {
        return invalidArgs('entity must be a live ParticleEffectPlayer in the active World');
      }
      if (!world.hasResource(VFX_GPU_RUNTIME_RESOURCE_KEY)) {
        return invalidArgs('the active World has no VfxGpuRuntime resource');
      }
      world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY).replay(entity as never);
      return { ok: true as const };
    }, 'Replay Particle Effect', {
      type: 'object',
      properties: { entity: { type: 'number', minimum: 0 } },
      required: ['entity'],
    });
    register('addSystem', (op) => {
      const name = (op as { name?: unknown }).name;
      if (typeof name !== 'string' || name.trim() === '') return invalidArgs('name must be a non-empty system name');
      const system = getRegisteredSystems().get(name);
      if (!system) return invalidArgs(`unknown system: ${name}`);
      deps.world.addSystem(Update, system).unwrap();
      return { ok: true };
    }, 'Enable System', {
      type: 'object', properties: { name: { type: 'string' } }, required: ['name'],
    });
    register('removeSystem', (op) => {
      const name = (op as { name?: unknown }).name;
      if (typeof name !== 'string' || name.trim() === '') return invalidArgs('name must be a non-empty system name');
      deps.world.removeSystem(Update, name).unwrap();
      return { ok: true };
    }, 'Disable System', {
      type: 'object', properties: { name: { type: 'string' } }, required: ['name'],
    });
  } catch (error) {
    for (let i = disposers.length - 1; i >= 0; i--) disposers[i]!();
    throw error;
  }
  return disposers;
}

export function registerViewportSessionAppliers(deps: ViewportSessionApplierDeps): () => void {
  const disposers = registerAll(deps);
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    for (let i = disposers.length - 1; i >= 0; i--) disposers[i]!();
  };
}
