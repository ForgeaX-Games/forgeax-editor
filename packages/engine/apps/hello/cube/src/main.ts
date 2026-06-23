// apps/hello/cube - ECS-driven binding exemplar (M4 RHI canvas-context migration).
//
// shadingModel routing (feat-20260518-pbr-direct-lighting-mvp / w24 / AC-13;
// feat-20260523 M8-T03 doc refresh: StandardMaterialAsset retired in favour
// of the schema-driven register API):
//   `populateDemoWorld` spawns the cube with `MeshRenderer { data: {} }` — the
//   empty material handle drops through render-system-extract.ts case B fallback
//   to `defaultMaterialSnapshot()` (mid-grey, `shadingModel: 'unlit'`). The
//   demo intentionally does NOT register a PBR material; basic-primitive demos
//   like hello-cube belong on the unlit pipeline (no DirectionalLight coupling
//   required). For an explicit `MaterialAsset { shadingModel: 'unlit' }`
//   register-and-bind exemplar see `apps/learn-render/1.getting-started/4.textures/src/index.ts`;
//   for the flagship schema-driven GGX-PBR + DirectionalLight pairing (built
//   via `assetRegistry.registerMaterialAsset({ materialShader:
//   'forgeax::default-standard-pbr', ... })`) see `apps/hello/room/src/main.ts`.
//
// Four-step recipe AI users discover via @forgeax/engine-runtime
// (charter proposition 1 progressive disclosure):
//   (1) import 5-component schemas + HANDLE_CUBE.
//   (2) world.spawn(...) cube + Camera + DirectionalLight.
//   (3) await renderer.ready (D-S3 manifest -> pipeline -> assets serial).
//   (4) raf -> renderer.draw(world) (D-S2 RenderSystem internal phase).
//
// M4 RHI canvas-context migration (feat-20260510-rhi-resource-creation /
// w28): the previous D-S1 single-point escape hatch
// (`_internal_getRawDevice`) is replaced with the M3-shipped RHI
// canvas-context abstraction. The shim translates the forgeax RhiDevice
// brand passed to `canvasContext.configure({ device, ... })` into the
// underlying raw GPUDevice via RAW_DEVICE_MAP so the spec
// `GPUCanvasContext.configure({ device })` slot still receives a valid
// raw device handle while AI-user-facing code only sees the forgeax
// abstraction (charter proposition 5 consistent abstraction red line).
//
// The canonical 3-entity demo World (cube + camera + directional light)
// is shared with apps/inspector-demo via apps/shared/src/populate-demo-world.ts
// (feat-20260514-ci-jscpd-duplication-gate M3 T-014 / clone #2 path-A cash-out).

import { World } from '@forgeax/engine-ecs';
import {
  acquireCanvasContext,
  createRenderer,
  EngineEnvironmentError,
  Name,
} from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { populateDemoWorld } from '../../../shared/src/populate-demo-world';

const world = new World();
populateDemoWorld(world);

// feat-20260515-ecs-name-component-and-string-schema M3 / w3-hello-cube-app
// (AC-14): canonical Name + 'string' schema vocab end-to-end exemplar. AI
// users discover the round-trip via `rg "Name { value:" apps/hello/cube` —
// spawn + read + mutate + despawn, all driven before the GPU pipeline so
// the BufferPool 3-path release is observable independent of the frame
// loop (R-P4 mitigation: separate the Name lifecycle from the renderer
// path so smoke verdict stays orthogonal to pixel readback).
{
  const player = world.spawn({ component: Name, data: { value: 'Player' } as never }).unwrap();
  const initialName = world.get(player, Name).unwrap().value;
  void initialName;
  world.set(player, Name, { value: 'Boss' } as never).unwrap();
  const mutatedName = world.get(player, Name).unwrap().value;
  void mutatedName;
  world.despawn(player).unwrap();
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-cube: missing <canvas id="app"> in index.html');
bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) console.error('[cube] no usable backend:', err);
  else console.error('[cube] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  // Round 3 fix-up F-P3-1 / w57: retired the second escape hatch (charter
  // proposition 5 red line; P3 Pure-B6) that monkey-patched
  // `rhi.requestAdapter` to capture the forgeax RhiDevice the engine
  // created internally. The Renderer interface now exposes the captured
  // device through `renderer.device: RhiDevice | null` (mirror of
  // apps/hello/triangle/src/main.ts; same red-line pattern as
  // shader / assets).
  const renderer = await createRenderer(target, {}, forgeaxBundlerAdapter());
    const ctxResult = acquireCanvasContext(target);
  if (ctxResult.ok) {
    const cfgResult = ctxResult.value.configure({
      device: renderer.device,
      format: 'rgba8unorm',
      usage: 0x10 | 0x01,
    });
    if (!cfgResult.ok)
      console.error('[cube] canvasContext.configure failed:', cfgResult.error);
  } else {
    console.error('[cube] acquireCanvasContext failed:', ctxResult.error);
  }
  console.warn(`[cube] backend=${renderer.backend}`);
  // w25 — Renderer.ready resolves Result<void, RhiError>; AI users branch
  // on `.ok` rather than try/catch.
  const ready = await renderer.ready;
  if (!ready.ok) {
    console.error('[cube] renderer.ready failed:', ready.error);
    return;
  }
  // raf-driven frame: engine internal RenderSystem walks the World query
  // graph (D-S2 Extract / Prepare / Record). Frame counter satisfies smoke
  // criterion (b) frames >= 300; pixel readback covers (c).
  const frame = (): void => {
    // w25 — Renderer.draw returns Result<void, RhiError>; transient errors
    // continue to fan out through onError; the Result return is the facade
    // synchronous summary (charter proposition 4 explicit failure).
    const r = renderer.draw(world);
    if (!r.ok) console.error('[cube] draw error:', r.error);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
