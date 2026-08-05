// M3 RED contract: Edit owns one engine ParticleRuntimeHost bridge.
// Anchors: requirements AC-02/AC-07, plan-strategy §2 D-1/D-2/D-5 and §7 M3.
// The implementation must keep the host feature and diagnostics engine-owned;
// this test deliberately does not create a VFX store or a protocol command.

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { World } from '@forgeax/engine-ecs';
import { createFramePhaseProfiler } from '../frame-phase-profiler';
import { createEditVfxRuntimeBridge } from '../vfx-runtime-bridge';

function makeHost() {
  const feature = {
    diagnostics: () => ({ readiness: 'ready', bucketCount: 1 }),
  };
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
  it('keeps one host feature and one engine-owned diagnostics source across repeated mounts', async () => {
    const editWorld = new World();
    const assets = { identity: 'shared-edit-registry' };
    const fake = makeHost();
    const bridge = createEditVfxRuntimeBridge({
      camera: { read: () => undefined },
      hostFactory: () => fake.host as never,
    });

    expect(bridge.host.feature as unknown).toBe(fake.host.feature as unknown);
    expect(bridge.readDiagnostics() as unknown).toEqual(fake.host.feature.diagnostics());
    expect(bridge.diagnosticsProvider.snapshot()).toMatchObject([{
      code: 'particle-render-ready',
      detail: {
        readiness: 'ready',
        provenance: {
          source: 'engine-vfx-render',
          host: 'ParticleRuntimeHost',
          feature: 'forgeax.vfx-render.particles',
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
    expect(source).toContain('createParticleRuntimeHost');
    expect(source).toContain('readAll');
  });

  it('notifies Gateway subscribers only when the engine diagnostic changes', () => {
    let readiness: 'ready' | 'failed' = 'ready';
    const fake = makeHost();
    fake.host.feature.diagnostics = () => ({ readiness, bucketCount: 1 });
    const bridge = createEditVfxRuntimeBridge({
      camera: { read: () => undefined },
      hostFactory: () => fake.host as never,
    });
    let notifications = 0;
    const unsubscribe = bridge.diagnosticsProvider.subscribe?.(() => { notifications += 1; });

    bridge.notifyDiagnosticsChanged();
    expect(notifications).toBe(0);
    readiness = 'failed';
    bridge.notifyDiagnosticsChanged();
    expect(notifications).toBe(1);
    bridge.notifyDiagnosticsChanged();
    expect(notifications).toBe(1);
    unsubscribe?.();
    readiness = 'ready';
    bridge.notifyDiagnosticsChanged();
    expect(notifications).toBe(1);
  });

  it('uses existing Gateway lifecycle operations as the executable recovery hint', () => {
    let readiness: 'ready' | 'failed' = 'failed';
    const fake = makeHost();
    fake.host.feature.diagnostics = () => ({ readiness, bucketCount: 0 });
    const bridge = createEditVfxRuntimeBridge({
      camera: { read: () => undefined },
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
