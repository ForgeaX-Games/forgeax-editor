// play-audio-wired.test.ts (solo round-17, P8) — the audio subsystem is present
// in the editor ▶ Play world.
//
// The friction this guards: `assemblePlayWorld` hardcoded the play plugin set to
// the 5 canvas-form defaults + optional physics and NEVER wired `audioPlugin()` or
// pre-injected an AudioBackend. So editor ▶ Play had no AUDIO_ENGINE_RESOURCE_KEY
// resource and no `audio-tick` system, and EVERY audio game's AudioSource silently
// never fired in Play (Edit≠Play — the same canvas-vs-assemble divergence class
// create-app.ts:455 fixed for AnimationAssetResolver).
//
// A structural test (not a live audio play): after assemblePlayWorld the play world
// MUST carry (1) the AUDIO_ENGINE_RESOURCE_KEY backend resource and (2) the
// `audio-tick` system (which audioPlugin registers only when it finds that
// resource — so the tick system's presence proves BOTH the plugin ran AND the
// backend was pre-injected before createApp). Reverting either edit turns this red.
//
// Anchors:
//   solo round-17 REPORT friction #3 (editor Play has no audio subsystem)
//   create-app.ts createAppFromAssemble (host owns backend lifecycle — must inject)
//   plugin-factory.ts AUDIO_TICK_SYSTEM_NAME + hasResource(AUDIO_ENGINE_RESOURCE_KEY) guard

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { AUDIO_ENGINE_RESOURCE_KEY, AUDIO_TICK_SYSTEM_NAME } from '@forgeax/engine-audio';
import { Camera, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { assemblePlayWorld } from '../play-assemble';

function makeFakeRenderer(onInstantiate?: () => void) {
  return {
    ready: Promise.resolve({ ok: true }),
    assets: {
      instantiate() {
        onInstantiate?.();
        return { ok: true as const, value: 1 };
      },
    },
    draw() {
      return { ok: true } as const;
    },
    dispose() {},
    onError(_cb: (e: unknown) => void) {
      return () => {};
    },
  };
}

describe('solo round-17 — editor ▶ Play wires the audio subsystem (P8)', () => {
  it('assemblePlayWorld injects the AudioBackend resource + the audio-tick system', async () => {
    const playWorld = new World();
    const renderer = makeFakeRenderer();

    const res = await assemblePlayWorld({
      renderer: renderer as never,
      loadDefaultScene: async () => null, // empty scene — audio wiring is scene-independent
      resolveBootstrap: async () => null,
      attachInput: () => undefined,
      newWorld: () => playWorld as never,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // (1) the AudioBackend was pre-injected as a world resource
    expect(
      (playWorld as unknown as { hasResource(k: unknown): boolean }).hasResource(
        AUDIO_ENGINE_RESOURCE_KEY,
      ),
    ).toBe(true);

    // (2) audioPlugin() registered the audio-tick system (it does so ONLY when it
    //     finds the backend resource — so this single assertion proves both the
    //     plugin ran AND the backend was injected before createApp).
    const insp = (playWorld as unknown as {
      inspect(): { systems: ReadonlyArray<{ name: string }> };
    }).inspect();
    const names = insp.systems.map((s) => s.name);
    expect(names).toContain(AUDIO_TICK_SYSTEM_NAME);
    expect([...playWorld.query({ with: [Camera] }).unwrap()]).toHaveLength(1);
  });

  it('does not inject a camera when a real game bootstrap owns the scene', async () => {
    const playWorld = new World();
    const res = await assemblePlayWorld({
      renderer: makeFakeRenderer() as never,
      loadDefaultScene: async () => null,
      resolveBootstrap: async () => (() => undefined) as never,
      attachInput: () => undefined,
      newWorld: () => playWorld as never,
    });

    expect(res.ok).toBe(true);
    expect([...playWorld.query({ with: [Camera] }).unwrap()]).toHaveLength(0);
  });

  it('preserves an authored default-scene camera when no bootstrap exists', async () => {
    const playWorld = new World();
    const res = await assemblePlayWorld({
      renderer: makeFakeRenderer(() => {
        playWorld.spawn(
          { component: Transform, data: { pos: [4, 5, 6] } },
          { component: Camera, data: perspective({ fov: Math.PI / 3, aspect: 2 }) },
        );
      }) as never,
      loadDefaultScene: async () => ({ guid: 'scene-with-camera' }) as never,
      resolveBootstrap: async () => null,
      attachInput: () => undefined,
      newWorld: () => playWorld as never,
    });

    expect(res.ok).toBe(true);
    const cameras = [...playWorld.query({ with: [Camera] }).unwrap()];
    expect(cameras).toHaveLength(1);
    expect(playWorld.get(cameras[0]!.entity, Camera).unwrap().aspect).toBeCloseTo(2);
  });
});
