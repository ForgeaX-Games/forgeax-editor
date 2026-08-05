// M3 RED/GREEN contract: Stop restores the persistent Edit projection after a
// fresh Play world is discarded. The host observation must not remain pointed
// at Play, and the shared renderer/registry identity must remain unchanged.
// Anchors: requirements AC-03/AC-06/AC-08, plan-strategy §2 D-1/D-2/D-5.

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { createEditVfxRuntimeBridge } from '../vfx-runtime-bridge';
import { createRunLifecycle, type RunGateway } from '../run-lifecycle';
import type { PlayAssembly } from '../play-assemble';

function createHost() {
  const attached: Array<{ world: World; assets: object }> = [];
  const detached: World[] = [];
  const host = {
    feature: {
      diagnostics: () => ({
        activeWorlds: attached.filter(({ world }) => !detached.includes(world)).length,
      }),
    },
    async attachWorld(input: { world: World; assets: object }) {
      if (attached.some(({ world }) => world === input.world)) {
        return { ok: true as const, value: { state: 'already-attached' as const } };
      }
      attached.push(input);
      return { ok: true as const, value: { state: 'attached' as const } };
    },
    detachWorld(input: { world: World }) {
      if (!detached.includes(input.world)) detached.push(input.world);
      return { ok: true as const, value: { state: 'detached' as const } };
    },
  };
  return { host, attached, detached };
}

function createGateway(events: string[]): RunGateway {
  return {
    enterPlay(world) { events.push(`enter:${String(world)}`); },
    exitPlay() { events.push('exit'); },
  };
}

describe('VFX Stop restore projection', () => {
  it('restores the persistent Edit host observation after dropping Play', async () => {
    const editWorld = new World();
    const assets = { identity: 'one-shared-renderer-registry' };
    const fake = createHost();
    const bridge = createEditVfxRuntimeBridge({
      camera: { read: () => undefined },
      hostFactory: () => fake.host as never,
    });
    expect((await bridge.attachWorld(editWorld, assets as never)).ok).toBe(true);

    const events: string[] = [];
    const lifecycle = createRunLifecycle({
      editorApp: {
        pause() { events.push('edit-pause'); return { ok: true as const }; },
        resume() { events.push('edit-resume'); return { ok: true as const }; },
      },
      gateway: createGateway(events),
      editWorld,
      assemble: async () => {
        const playWorld = new World();
        const attached = await bridge.attachWorld(playWorld, assets as never);
        if (!attached.ok) return attached;
        const playApp = {
          start() { return { ok: true as const }; },
          stop() { events.push('play-stop'); return { ok: true as const }; },
          pause() { return { ok: true as const }; },
          resume() { return { ok: true as const }; },
        };
        const assembly: PlayAssembly = {
          playApp,
          playWorld,
          detachBeforeStop() {
            events.push('play-detach');
            bridge.detachWorld(playWorld);
          },
          disposeWorld() {},
          detach() {},
        };
        return { ok: true as const, value: assembly };
      },
    });

    await lifecycle.playSimulation();
    const playWorld = lifecycle.currentPlayWorld() as World | null;
    expect(playWorld).not.toBeNull();
    if (playWorld === null) throw new Error('Play world was not assembled');
    expect(bridge.readDiagnostics() as unknown).toEqual({ activeWorlds: 2 });

    lifecycle.stopSimulation();

    expect(lifecycle.currentPlayWorld()).toBeNull();
    expect(bridge.readDiagnostics() as unknown).toEqual({ activeWorlds: 1 });
    expect(fake.attached[0]).toEqual({ world: editWorld, assets });
    expect(fake.detached).toEqual([playWorld]);
    expect(events.indexOf('play-detach')).toBeLessThan(events.indexOf('play-stop'));
    expect(events).toContain('edit-resume');
  });
});
