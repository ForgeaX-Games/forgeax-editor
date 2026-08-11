// M3 RED contract: Edit owns one engine VfxRuntimeHost bridge.
// Anchors: requirements AC-02/AC-07, plan-strategy §2 D-1/D-2/D-5 and §7 M3.
// The implementation must keep the host feature and diagnostics engine-owned;
// this test deliberately does not create a VFX store or a protocol command.

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { World } from '@forgeax/engine-ecs';
import { createFramePhaseProfiler } from '../frame-phase-profiler';
import { createEditVfxRuntimeBridge } from '../vfx-runtime-bridge';
import { supportsVfxRenderFeature } from '../vfx-render-capability';

function makeHost() {
  const feature = { identity: 'forgeax.vfx-render.gpu-particles' };
  const attached: Array<{ world: unknown; assets: unknown }> = [];
  const detached: unknown[] = [];
  const host = {
    feature,
    async attachWorld(input: { world: unknown; assets: unknown }) {
      if (attached.some((entry) => entry.world === input.world)) {
        return { ok: true as const, value: { state: 'already-attached' as const } };
      }
      attached.push(input);
      return { ok: true as const, value: { state: 'attached' as const } };
    },
    detachWorld(input: { world: unknown }) {
      if (!detached.includes(input.world)) detached.push(input.world);
      return { ok: true as const, value: { state: 'detached' as const } };
    },
  };
  return { host, attached, detached };
}

describe('Edit VFX runtime bridge', () => {
  it('gates GPU particle rendering on the active RHI capabilities', () => {
    expect(supportsVfxRenderFeature({ compute: true, indirectDrawing: true })).toBe(true);
    expect(supportsVfxRenderFeature({ compute: false, indirectDrawing: true })).toBe(false);
    expect(supportsVfxRenderFeature({ compute: true, indirectDrawing: false })).toBe(false);
    expect(supportsVfxRenderFeature(undefined)).toBe(false);
  });

  it('keeps one host feature and one engine-owned diagnostics source across repeated mounts', async () => {
    const editWorld = new World();
    const assets = { identity: 'shared-edit-registry' };
    const fake = makeHost();
    const diagnostics = [{
      identity: 'forgeax.vfx-render.gpu-particles',
      order: 0,
      status: 'active' as const,
      latestError: undefined,
    }];
    const bridge = createEditVfxRuntimeBridge({
      camera: { read: () => undefined },
      renderFeatureDiagnostics: () => diagnostics,
      hostFactory: () => fake.host as never,
    });

    expect(bridge.host.feature as unknown).toBe(fake.host.feature as unknown);
    expect(bridge.readDiagnostics()).toEqual(diagnostics);
    expect(bridge.diagnosticsProvider.snapshot()).toMatchObject([{
      code: 'particle-render-active',
      detail: {
        status: 'active',
        provenance: {
          source: 'engine-vfx-render',
          host: 'VfxRuntimeHost',
          feature: 'forgeax.vfx-render.gpu-particles',
        },
      },
    }]);

    const first = await bridge.attachWorld(editWorld, assets as never);
    const duplicate = await bridge.attachWorld(editWorld, assets as never);
    expect(first.ok).toBe(true);
    expect(duplicate.ok).toBe(true);
    expect(fake.attached).toHaveLength(1);
    expect(fake.attached[0]).toEqual({ world: editWorld, assets });

    const detached = bridge.detachWorld(editWorld);
    expect(detached.ok).toBe(true);
    expect(fake.detached).toEqual([editWorld]);
  });

  it('does not route VFX through VAG or a UI store setter', () => {
    const source = readFileSync(fileURLToPath(new URL('../vfx-runtime-bridge.ts', import.meta.url)), 'utf8');
    expect(source).not.toContain('editor-core/protocol');
    expect(source).not.toMatch(/store\/.*set[A-Z]/);
    expect(source).toContain('createVfxRuntimeHost');
    expect(source).toContain('renderFeatureDiagnostics');
  });

  it('attaches the Edit VFX world only after the scoped asset catalog is ready', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../ViewportComponent.tsx', import.meta.url)),
      'utf8',
    );
    const configure = source.indexOf('renderer.assets.configureRuntimeBinding');
    const enumerate = source.indexOf('await renderer.assets.enumerateCatalog()');
    const attach = source.indexOf('await vfxBridge.attachWorld(world, renderer.assets)');

    expect(configure).toBeGreaterThan(-1);
    expect(enumerate).toBeGreaterThan(configure);
    expect(attach).toBeGreaterThan(enumerate);
  });

  it('notifies Gateway subscribers only when the engine diagnostic changes', () => {
    let status: 'active' | 'failed' = 'active';
    const fake = makeHost();
    const bridge = createEditVfxRuntimeBridge({
      camera: { read: () => undefined },
      renderFeatureDiagnostics: () => [{
        identity: 'forgeax.vfx-render.gpu-particles',
        order: 0,
        status,
        latestError: undefined,
      }],
      hostFactory: () => fake.host as never,
    });
    let notifications = 0;
    const unsubscribe = bridge.diagnosticsProvider.subscribe?.(() => { notifications += 1; });

    bridge.notifyDiagnosticsChanged();
    expect(notifications).toBe(0);
    status = 'failed';
    bridge.notifyDiagnosticsChanged();
    expect(notifications).toBe(1);
    bridge.notifyDiagnosticsChanged();
    expect(notifications).toBe(1);
    unsubscribe?.();
    status = 'active';
    bridge.notifyDiagnosticsChanged();
    expect(notifications).toBe(1);
  });

  it('uses existing Gateway lifecycle operations as the executable recovery hint', () => {
    const fake = makeHost();
    const bridge = createEditVfxRuntimeBridge({
      camera: { read: () => undefined },
      renderFeatureDiagnostics: () => [{
        identity: 'forgeax.vfx-render.gpu-particles',
        order: 0,
        status: 'failed',
        latestError: undefined,
      }],
      hostFactory: () => fake.host as never,
    });

    expect(bridge.diagnosticsProvider.snapshot()).toMatchObject([{
      retryable: true,
      recoveryActions: ['stop', 'play'],
      detail: { recovery: { via: 'gateway.dispatch', operations: ['stop', 'play'] } },
    }]);
  });

  it('receives production render-phase callbacks from the profiler owner without enabling User Timing', () => {
    const events: string[] = [];
    const globalState = globalThis as { __forgeaxFramePhaseDiagnostics?: unknown };
    const previous = globalState.__forgeaxFramePhaseDiagnostics;
    delete globalState.__forgeaxFramePhaseDiagnostics;
    try {
      const profiler = createFramePhaseProfiler({
        onPhaseEnd: (event) => events.push(`${event.source}:${event.phase}`),
      });
      expect(profiler).toBeDefined();
      const session = profiler?.activeSession();
      session?.beginFrame(1);
      session?.beginPhase({ source: 'render', phase: 'features' });
      session?.endPhase();
      expect(events).toEqual(['render:features']);
    } finally {
      if (previous === undefined) delete globalState.__forgeaxFramePhaseDiagnostics;
      else globalState.__forgeaxFramePhaseDiagnostics = previous;
    }
  });
});
