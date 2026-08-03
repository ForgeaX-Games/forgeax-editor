// play-aspect-sync.test.ts — editor ▶ Play keeps Camera.aspect tracking the
// canvas across resizes (the play·game stretch-on-resize regression).
//
// The friction this guards: the engine's canvas form auto-registers
// `app-sync-camera-aspect` (create-app.ts), but the ASSEMBLE form — which
// assemblePlayWorld uses — deliberately does not (host-engine contract: "Only
// the createApp(canvas) path auto-wires the aspect-sync sidecar"). While the
// editor App is paused for ▶ Play its canvas sidecar is frozen too, so a
// viewport/dock resize updated canvas.width/height (the host ResizeObserver
// keeps running) but every play-world Camera.aspect stayed frozen at its spawn
// value — the play view stretched instead of re-fitting (Edit≠Play).
//
// A structural test (not a live render): assemblePlayWorld with a canvas dep
// MUST register a per-frame system that writes canvas.width/canvas.height into
// every autoAspect perspective Camera's aspect — including size CHANGES after
// assembly (the resize case), while leaving autoAspect:false cameras untouched
// and never writing NaN/0 for a zero-sized canvas. Reverting the
// play-camera-aspect-sync registration turns this red.
//
// Anchors:
//   play-assemble.ts play-camera-aspect-sync + REMOVAL ANCHOR (engine barrel
//     export feedback
//     2026-08-03-assemble-form-host-cannot-wire-aspect-buffer-sync-not-barrel-exported)
//   engine create-app.ts syncCameraAspect (the canvas-form behavior mirrored)
//   host-engine contract: assemble hosts manage their own sync

import { describe, expect, it } from 'bun:test';
import { World, type EntityHandle } from '@forgeax/engine-ecs';
import { Camera, perspective, orthographic } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { assemblePlayWorld } from '../play-assemble';

function makeFakeRenderer() {
  return {
    ready: Promise.resolve({ ok: true }),
    assets: {
      instantiate() {
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

/** The sync reads only width/height — a plain object stands in for the canvas. */
function makeFakeCanvas(width: number, height: number): HTMLCanvasElement {
  return { width, height } as HTMLCanvasElement;
}

type CameraWorld = {
  spawn(...cd: unknown[]): { unwrap(): EntityHandle };
  get(e: EntityHandle, c: unknown): { ok: boolean; value: { aspect: number } };
  update(): unknown;
};

async function assembleWithCamera(canvas: HTMLCanvasElement, spawnCameras: (world: CameraWorld) => void) {
  const playWorld = new World();
  const res = await assemblePlayWorld({
    renderer: makeFakeRenderer() as never,
    loadDefaultScene: async () => null,
    resolveBootstrap: async () => ((world: unknown) => {
      spawnCameras(world as unknown as CameraWorld);
    }) as never,
    attachInput: () => undefined,
    newWorld: () => playWorld as never,
    canvas,
  });
  expect(res.ok).toBe(true);
  return playWorld as unknown as CameraWorld;
}

describe('editor ▶ Play mirrors the canvas-form camera aspect-sync (resize re-fit)', () => {
  it('tracks canvas aspect across a post-assembly resize; autoAspect:false untouched', async () => {
    const canvas = makeFakeCanvas(800, 600);
    let autoCam: EntityHandle = 0 as EntityHandle;
    let manualCam: EntityHandle = 0 as EntityHandle;
    const world = await assembleWithCamera(canvas, (w) => {
      autoCam = w.spawn(
        { component: Transform, data: { pos: [0, 0, 5] } },
        { component: Camera, data: perspective({ fov: Math.PI / 3, aspect: 1, far: 1000 }) },
      ).unwrap();
      manualCam = w.spawn(
        { component: Transform, data: { pos: [0, 0, 5] } },
        { component: Camera, data: perspective({ fov: Math.PI / 3, aspect: 2, far: 1000, autoAspect: false }) },
      ).unwrap();
    });

    world.update();
    expect(world.get(autoCam, Camera).value.aspect).toBeCloseTo(800 / 600, 6);
    expect(world.get(manualCam, Camera).value.aspect).toBeCloseTo(2, 6);

    // The resize: host ResizeObserver writes new canvas pixels; the next play
    // frame must re-fit the projection instead of stretching.
    canvas.width = 400;
    canvas.height = 600;
    world.update();
    expect(world.get(autoCam, Camera).value.aspect).toBeCloseTo(400 / 600, 6);
    expect(world.get(manualCam, Camera).value.aspect).toBeCloseTo(2, 6);
  });

  it('never writes NaN/0 aspect for a zero-sized canvas (detached/display:none)', async () => {
    const canvas = makeFakeCanvas(0, 0);
    let cam: EntityHandle = 0 as EntityHandle;
    const world = await assembleWithCamera(canvas, (w) => {
      cam = w.spawn(
        { component: Transform, data: { pos: [0, 0, 5] } },
        { component: Camera, data: perspective({ fov: Math.PI / 3, aspect: 1.5, far: 1000 }) },
      ).unwrap();
    });

    world.update();
    expect(world.get(cam, Camera).value.aspect).toBeCloseTo(1.5, 6);
  });

  it('leaves orthographic cameras untouched', async () => {
    const canvas = makeFakeCanvas(800, 600);
    let cam: EntityHandle = 0 as EntityHandle;
    const world = await assembleWithCamera(canvas, (w) => {
      cam = w.spawn(
        { component: Transform, data: { pos: [0, 0, 5] } },
        { component: Camera, data: orthographic({ left: -1, right: 1, bottom: -1, top: 1, near: 0.1, far: 100 }) },
      ).unwrap();
    });

    const before = world.get(cam, Camera).value.aspect;
    world.update();
    expect(world.get(cam, Camera).value.aspect).toBe(before);
  });

  it('no canvas dep (headless) → no aspect-sync system, aspect holds spawn value', async () => {
    const playWorld = new World();
    let cam: EntityHandle = 0 as EntityHandle;
    const res = await assemblePlayWorld({
      renderer: makeFakeRenderer() as never,
      loadDefaultScene: async () => null,
      resolveBootstrap: async () => ((world: unknown) => {
        cam = (world as unknown as CameraWorld).spawn(
          { component: Transform, data: { pos: [0, 0, 5] } },
          { component: Camera, data: perspective({ fov: Math.PI / 3, aspect: 1.5, far: 1000 }) },
        ).unwrap();
      }) as never,
      attachInput: () => undefined,
      newWorld: () => playWorld as never,
    });
    expect(res.ok).toBe(true);

    const world = playWorld as unknown as CameraWorld;
    world.update();
    expect(world.get(cam, Camera).value.aspect).toBeCloseTo(1.5, 6);
  });
});
