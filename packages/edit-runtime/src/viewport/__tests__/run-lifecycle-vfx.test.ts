// M3 RED contract: in-process Play owns a fresh World while sharing the Edit
// AssetRegistry and VfxRuntimeHost. Stop must detach Play before stopping
// its App, then leave the Edit binding available for the next run.
//
// Anchors: requirements AC-03/AC-06/AC-08, plan-strategy §2 D-2/D-6 and §7 M3.

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { createEditVfxRuntimeBridge } from '../vfx-runtime-bridge';
import { createRunLifecycle, type RunGateway } from '../run-lifecycle';
import type { PlayAssembly } from '../play-assemble';

function createFakeHost() {
  const attached: Array<{ world: World; assets: object }> = [];
  const detached: World[] = [];
  const host = {
    feature: { identity: 'forgeax.vfx-render.gpu-particles' },
    async attachWorld(input: { world: World; assets: object }) {
      if (attached.some((entry) => entry.world === input.world)) {
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
    beginPlayAttempt() {},
    failPlayAttempt() {},
  };
}

describe('in-process VFX Play lifecycle', () => {
  it('uses one registry, a fresh World per Play, and detaches Play before stop', async () => {
    const editWorld = new World();
    const assets = { identity: 'edit-registry' };
    const fake = createFakeHost();
    const bridge = createEditVfxRuntimeBridge({
      camera: { read: () => undefined },
      renderFeatureDiagnostics: () => [],
      hostFactory: () => fake.host as never,
    });
    const editAttach = await bridge.attachWorld(editWorld, assets as never);
    expect(editAttach.ok).toBe(true);

    const events: string[] = [];
    const editorApp = {
      pause() { events.push('edit-pause'); return { ok: true as const }; },
      resume() { events.push('edit-resume'); return { ok: true as const }; },
    };
    const gateway = createGateway(events);
    const playWorlds: World[] = [];
    const playApps: Array<{ start(): { ok: true }; stop(): { ok: true } }> = [];
    const lifecycle = createRunLifecycle({
      editorApp,
      gateway,
      editWorld,
      assemble: async () => {
        const playWorld = new World();
        playWorlds.push(playWorld);
        const attached = await bridge.attachWorld(playWorld, assets as never);
        if (!attached.ok) return attached;
        const playApp = {
          start() { events.push('play-start'); return { ok: true as const }; },
          stop() { events.push('play-stop'); return { ok: true as const }; },
          pause() { return { ok: true as const }; },
          resume() { return { ok: true as const }; },
        };
        playApps.push(playApp);
        const assembly: PlayAssembly = {
          playApp,
          playWorld,
          detachBeforeStop() {
            events.push('play-detach');
            bridge.detachWorld(playWorld);
          },
          detach() { events.push('assembly-detach'); },
        };
        return { ok: true as const, value: assembly };
      },
    });

    await lifecycle.playSimulation();
    expect(lifecycle.currentPlayWorld()).toBe(playWorlds[0]);
    expect(playWorlds[0]).not.toBe(editWorld);
    expect(fake.attached).toHaveLength(2);
    expect(fake.attached.every((entry) => entry.assets === assets)).toBe(true);

    await lifecycle.playSimulation();
    expect(playWorlds).toHaveLength(1);

    lifecycle.stopSimulation();
    expect(lifecycle.currentPlayWorld()).toBeNull();
    expect(fake.detached).toEqual(playWorlds.slice(0, 1));
    expect(events.indexOf('play-detach')).toBeLessThan(events.indexOf('play-stop'));
    expect(events).toContain('edit-resume');

    lifecycle.stopSimulation();
    expect(fake.detached).toHaveLength(1);

    await lifecycle.playSimulation();
    expect(playWorlds).toHaveLength(2);
    expect(playWorlds[1]).not.toBe(playWorlds[0]);
    expect(fake.attached).toHaveLength(3);
    expect(fake.attached[2]?.assets).toBe(assets);
    expect(playApps).toHaveLength(2);

    lifecycle.stopSimulation();
    expect(fake.detached).toEqual(playWorlds);
    expect(fake.attached[0]?.world).toBe(editWorld);
    expect(fake.attached.filter(({ world }) => !fake.detached.includes(world))).toEqual([
      { world: editWorld, assets },
    ]);
  });
});
