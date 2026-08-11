import { describe, expect, test } from 'bun:test';
import type { ExecutionRealmBootstrapContext } from '@forgeax/engine-app';
import {
  PLAY_EXECUTION_PROTOCOL,
  createPlayExecutionDiagnosticsStore,
  isPlayExecutionRealmMessage,
  parsePlayExecutionBootstrapData,
} from '../execution-contract';
import executionBootstrap, {
  createPlayExecutionPulse,
  projectRuntimeDiagnostics,
} from '../execution-bootstrap';

describe('Play thick execution contract', () => {
  test('installs the realm-local audio intent system for main and Worker tiers', async () => {
    const gameEntryUrl = 'data:text/javascript,export default async()=>({run(){}})';
    const prepared = await executionBootstrap({
      protocol: PLAY_EXECUTION_PROTOCOL,
      gameId: 'sample',
      gameEntryUrl,
      gamePluginModules: [],
    });

    expect(prepared.plugins?.map((plugin) => plugin.name)).toContain('audio');
  });

  test('rejects malformed thick game modules before a realm starts', async () => {
    await expect(executionBootstrap({
      protocol: PLAY_EXECUTION_PROTOCOL,
      gameId: 'sample',
      gameEntryUrl: 'data:text/javascript,export default 1',
      gamePluginModules: [],
    })).rejects.toThrow('default-export an ExecutionBootstrapEntry');
    await expect(executionBootstrap({
      protocol: PLAY_EXECUTION_PROTOCOL,
      gameId: 'sample',
      gameEntryUrl: 'data:text/javascript,export default async()=>null',
      gamePluginModules: [],
    })).rejects.toThrow('prepare an object with run(context)');
  });

  test('accepts structured-clone bootstrap data and rejects missing identity', () => {
    expect(parsePlayExecutionBootstrapData({
      protocol: PLAY_EXECUTION_PROTOCOL,
      gameId: 'sample',
      gameEntryUrl: 'https://runtime.test/sample/execution.ts',
      gamePluginModules: [],
    })).toMatchObject({ gameId: 'sample' });
    expect(() => parsePlayExecutionBootstrapData({
      protocol: PLAY_EXECUTION_PROTOCOL,
      gameEntryUrl: 'https://runtime.test/sample/execution.ts',
      gamePluginModules: [],
    })).toThrow('invalid');
  });

  test('fences malformed realm messages instead of treating a kind string as readiness', () => {
    expect(isPlayExecutionRealmMessage({
      protocol: PLAY_EXECUTION_PROTOCOL,
      kind: 'realm-ready',
      rendererIdentity: 'renderer-a',
      rendererGeneration: 2,
    })).toBe(true);
    expect(isPlayExecutionRealmMessage({
      protocol: PLAY_EXECUTION_PROTOCOL,
      kind: 'heartbeat',
      fps: 60,
      sentinel: 3,
    })).toBe(true);
    expect(isPlayExecutionRealmMessage({
      protocol: PLAY_EXECUTION_PROTOCOL,
      kind: 'runtime-diagnostics',
      diagnostics: {
        entityCount: 3,
        activeComponents: ['ParticleEffectPlayer'],
        vfxRuntimePresent: true,
        queuedIntents: 1,
        runtimeDiagnostics: [],
        featureStatus: 'active',
      },
    })).toBe(true);
    expect(isPlayExecutionRealmMessage({ protocol: PLAY_EXECUTION_PROTOCOL, kind: 'heartbeat' })).toBe(false);
    expect(isPlayExecutionRealmMessage({
      protocol: PLAY_EXECUTION_PROTOCOL,
      kind: 'runtime-diagnostics',
      diagnostics: { entityCount: -1 },
    })).toBe(false);
    expect(isPlayExecutionRealmMessage({
      protocol: PLAY_EXECUTION_PROTOCOL,
      kind: 'realm-ready',
      rendererIdentity: 'renderer-a',
      rendererGeneration: -1,
    })).toBe(false);
  });

  test('projects disposable Worker diagnostics without creating a host World', () => {
    const vfxRuntime = {
      snapshot: () => [{ kind: 'emit' }],
      diagnostics: () => [{ code: 'vfx-ready' }],
    };
    const context = {
      world: {
        inspect: () => ({ entityCount: 7, activeComponents: ['ParticleEffectPlayer'] }),
        hasResource: (name: string) => name === 'VfxGpuRuntime',
        getResource: () => vfxRuntime,
      },
      renderer: {
        perFramePassNames: ['forgeax.vfx-render.gpu-particles::gpu.main.draw.regular'],
        renderFeatureDiagnostics: () => [{
          identity: 'forgeax.vfx-render.gpu-particles',
          status: 'active',
          latestError: { code: 'none' },
        }],
      },
    } as unknown as ExecutionRealmBootstrapContext;

    expect(projectRuntimeDiagnostics(context)).toEqual({
      entityCount: 7,
      activeComponents: ['ParticleEffectPlayer'],
      vfxRuntimePresent: true,
      queuedIntents: 1,
      runtimeDiagnostics: [{ code: 'vfx-ready' }],
      featurePass: 'forgeax.vfx-render.gpu-particles::gpu.main.draw.regular',
      featureStatus: 'active',
      featureError: { code: 'none' },
    });
  });

  test('projects an explicit unavailable VFX snapshot', () => {
    const context = {
      world: {
        inspect: () => ({ entityCount: 0, activeComponents: [] }),
        hasResource: () => false,
      },
      renderer: {
        perFramePassNames: [],
        renderFeatureDiagnostics: () => [],
      },
    } as unknown as ExecutionRealmBootstrapContext;

    expect(projectRuntimeDiagnostics(context)).toEqual({
      entityCount: 0,
      activeComponents: [],
      vfxRuntimePresent: false,
      queuedIntents: -1,
      runtimeDiagnostics: [],
      featureError: undefined,
    });
  });

  test('keeps one disposable host snapshot and ignores control messages', () => {
    const store = createPlayExecutionDiagnosticsStore();
    const heartbeat = {
      protocol: PLAY_EXECUTION_PROTOCOL,
      kind: 'heartbeat' as const,
      fps: 60,
      sentinel: 1,
    };
    const diagnostics = {
      protocol: PLAY_EXECUTION_PROTOCOL,
      kind: 'runtime-diagnostics' as const,
      diagnostics: {
        entityCount: 1,
        activeComponents: [],
        vfxRuntimePresent: false,
        queuedIntents: -1,
        runtimeDiagnostics: [],
      },
    };

    expect(store.snapshot()).toBeUndefined();
    expect(store.accept(heartbeat)).toBe(false);
    expect(store.accept(diagnostics)).toBe(true);
    expect(store.snapshot()).toBe(diagnostics.diagnostics);
  });

  test('publishes bounded diagnostics and monotonic heartbeats from one pulse clock', () => {
    const pulse = createPlayExecutionPulse();

    expect(pulse(0.04)).toEqual({ diagnosticsDue: false });
    expect(pulse(0.06)).toEqual({
      diagnosticsDue: false,
      heartbeat: { fps: 20, sentinel: 1 },
    });
    expect(pulse(0.5)).toEqual({
      diagnosticsDue: true,
      heartbeat: { fps: 2, sentinel: 2 },
    });
    expect(pulse(0.05)).toEqual({ diagnosticsDue: false });
  });
});
