import { describe, expect, test } from 'bun:test';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { ChildOf, Name } from '@forgeax/engine-scene';
import {
  PLAY_EXECUTION_PROTOCOL,
  createPlayRendererProvenance,
  createPlayExecutionDiagnosticsStore,
  isPlayExecutionRealmMessage,
  parsePlayExecutionBootstrapData,
  type PlayExecutionRealmContext,
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
      renderer: {
        identity: 'renderer-123e4567-e89b-42d3-a456-426614174000',
        generation: 2,
        backend: 'webgpu',
        caps: ['compute', 'indirect'],
      },
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
        entities: [{
          entity: 7,
          components: ['Name', 'MeshFilter', 'MeshRenderer', 'ChildOf'],
          name: 'Player',
          meshFilter: { hasAsset: true },
          meshRenderer: { materialCount: 2 },
          childOf: { parent: 1 },
        }],
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
      kind: 'runtime-diagnostics',
      diagnostics: {
        entityCount: 1,
        activeComponents: [],
        entities: [{ entity: -1, components: [] }],
        vfxRuntimePresent: false,
        queuedIntents: 0,
        runtimeDiagnostics: [],
      },
    })).toBe(false);
    expect(isPlayExecutionRealmMessage({
      protocol: PLAY_EXECUTION_PROTOCOL,
      kind: 'runtime-diagnostics',
      diagnostics: {
        entityCount: 1,
        activeComponents: [],
        entities: [{ entity: 1, components: [], childOf: { parent: -1 } }],
        vfxRuntimePresent: false,
        queuedIntents: 0,
        runtimeDiagnostics: [],
      },
    })).toBe(false);
    expect(isPlayExecutionRealmMessage({
      protocol: PLAY_EXECUTION_PROTOCOL,
      kind: 'runtime-diagnostics',
      diagnostics: {
        entityCount: 1,
        activeComponents: [],
        entities: [{ entity: 1, components: [], meshRenderer: { materialCount: -1 } }],
        vfxRuntimePresent: false,
        queuedIntents: 0,
        runtimeDiagnostics: [],
      },
    })).toBe(false);
    expect(isPlayExecutionRealmMessage({
      protocol: PLAY_EXECUTION_PROTOCOL,
      kind: 'realm-ready',
      renderer: {
        identity: 'renderer-123e4567-e89b-42d3-a456-426614174000',
        generation: 0,
        backend: 'webgpu',
        caps: ['compute', 'indirect'],
      },
    })).toBe(false);
    expect(isPlayExecutionRealmMessage({
      protocol: PLAY_EXECUTION_PROTOCOL,
      kind: 'realm-ready',
      renderer: {
        identity: 'unavailable',
        generation: 2,
        backend: 'webgpu',
        caps: ['compute', 'indirect'],
      },
    })).toBe(false);
    expect(isPlayExecutionRealmMessage({
      protocol: PLAY_EXECUTION_PROTOCOL,
      kind: 'realm-ready',
      renderer: {
        identity: 'renderer-123e4567-e89b-42d3-a456-426614174000',
        generation: 2,
        backend: '',
        caps: ['compute', 'indirect'],
      },
    })).toBe(false);
    expect(isPlayExecutionRealmMessage({
      protocol: PLAY_EXECUTION_PROTOCOL,
      kind: 'realm-ready',
      renderer: {
        identity: 'renderer-123e4567-e89b-42d3-a456-426614174000',
        generation: 2,
        backend: 'webgpu',
        caps: ['indirect', 'compute'],
      },
    })).toBe(false);
  });

  test('mints complete producer provenance from live renderer facts', () => {
    const renderer = (backendKind: string, capabilities: Record<string, unknown>) => ({
      inspect: () => ({ capabilities: { backendKind, ...capabilities } }),
    }) as unknown as Parameters<typeof createPlayRendererProvenance>[0];
    const provenance = createPlayRendererProvenance(
      renderer('webgpu', { indirect: true, compute: true }),
      1,
    );
    expect(provenance).toMatchObject({
      generation: 1,
      backend: 'webgpu',
      caps: ['compute', 'indirect'],
    });
    expect(provenance?.identity).toMatch(/^renderer-[0-9a-f-]{36}$/u);
    expect(createPlayRendererProvenance(renderer('webgpu', {}), 0)).toBeNull();
    expect(createPlayRendererProvenance(renderer('', {}), 1)).toBeNull();
  });

  test('projects borrowed Worker query rows before the engine rebinds them', () => {
    const vfxRuntime = {
      snapshot: () => [{ kind: 'emit' }],
      diagnostics: () => [{ code: 'vfx-ready' }],
    };
    const sourceRows = [
      { entity: 41, name: 'Reference Upper', assetHandle: 7, materials: [3, 5], parent: 42 },
      { entity: 42, name: 'Reference Root', assetHandle: 9, materials: [11], parent: 99 },
    ];
    const row = {
      entity: 0,
      get: (component: unknown) => {
        const source = sourceRows.find((candidate) => candidate.entity === row.entity);
        if (source === undefined) return undefined;
        if (component === Name) return { value: source.name };
        if (component === MeshFilter) return { assetHandle: source.assetHandle };
        if (component === MeshRenderer) return { materials: source.materials };
        if (component === ChildOf && source.parent !== undefined) {
          return { parent: source.parent };
        }
        return undefined;
      },
    };
    const borrowedRows = {
      [Symbol.iterator](): Iterator<typeof row> {
        let index = 0;
        return {
          next: () => {
            const source = sourceRows[index++];
            if (source === undefined) return { done: true, value: undefined };
            row.entity = source.entity;
            return { done: false, value: row };
          },
        };
      },
    };
    const context = {
      world: {
        inspect: () => ({ entityCount: 7, activeComponents: ['ParticleEffectPlayer'] }),
        query: () => ({ unwrap: () => borrowedRows }),
        hasResource: (name: string) => name === 'VfxGpuRuntime',
        getResource: () => vfxRuntime,
      },
      renderer: { inspect: () => ({
        perFramePassNames: ['forgeax.vfx-render.gpu-particles::gpu.main.draw.regular'],
        featureDiagnostics: [{
          identity: 'forgeax.vfx-render.gpu-particles',
          status: 'active',
          latestError: { code: 'none' },
        }],
      }) },
    } as unknown as PlayExecutionRealmContext;

    expect(projectRuntimeDiagnostics(context)).toEqual({
      entityCount: 7,
      activeComponents: ['ParticleEffectPlayer'],
      entities: [
        {
          entity: 41,
          components: ['Name', 'MeshFilter', 'MeshRenderer', 'ChildOf'],
          name: 'Reference Upper',
          meshFilter: { hasAsset: true },
          meshRenderer: { materialCount: 2 },
          childOf: { parent: 42 },
        },
        {
          entity: 42,
          components: ['Name', 'MeshFilter', 'MeshRenderer'],
          name: 'Reference Root',
          meshFilter: { hasAsset: true },
          meshRenderer: { materialCount: 1 },
        },
      ],
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
        query: () => ({ unwrap: () => [] }),
        hasResource: () => false,
      },
      renderer: { inspect: () => ({
        perFramePassNames: [],
        featureDiagnostics: [],
      }) },
    } as unknown as PlayExecutionRealmContext;

    expect(projectRuntimeDiagnostics(context)).toEqual({
      entityCount: 0,
      activeComponents: [],
      entities: [],
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
        entities: [],
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

  test('t10-c associates the Worker projection with the prior owner commit', () => {
    // Historical owner association for the original t10-c Worker projection:
    // cacafd3af4367c2d13e027fa45743e918544980c.
    const priorOwnerCommit = 'cacafd3af4367c2d13e027fa45743e918544980c';
    const store = createPlayExecutionDiagnosticsStore();
    const diagnostics = {
      protocol: PLAY_EXECUTION_PROTOCOL,
      kind: 'runtime-diagnostics' as const,
      diagnostics: {
        entityCount: 3,
        activeComponents: ['Name', 'MeshFilter', 'MeshRenderer', 'ChildOf'],
        entities: [{
          entity: 7,
          components: ['Name', 'MeshFilter', 'MeshRenderer'],
          name: 'Reference Root',
          meshFilter: { hasAsset: true },
          meshRenderer: { materialCount: 1 },
        }],
        vfxRuntimePresent: false,
        queuedIntents: 0,
        runtimeDiagnostics: [{ ownerCommit: priorOwnerCommit, projection: 'Worker entity diagnostics' }],
      },
    };

    expect(store.accept(diagnostics)).toBe(true);
    expect(store.snapshot()?.runtimeDiagnostics).toEqual([
      { ownerCommit: priorOwnerCommit, projection: 'Worker entity diagnostics' },
    ]);
  });

  test('publishes bounded diagnostics independently of renderer heartbeat', () => {
    const pulse = createPlayExecutionPulse();

    expect(pulse(0.04)).toEqual({ diagnosticsDue: false });
    expect(pulse(0.06)).toEqual({ diagnosticsDue: false });
    expect(pulse(0.5)).toEqual({ diagnosticsDue: true });
    expect(pulse(0.05)).toEqual({ diagnosticsDue: false });
  });
});
