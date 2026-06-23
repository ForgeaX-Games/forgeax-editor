// apps/hello/bloom -- Bloom real-time comparison demo
// (feat-20260531-bloom-first-declarative-render-graph-pass / M4 / w18).
//
// What this demo exercises end-to-end (charter F1 progressive disclosure):
//   - createApp(canvas, opts) -- one-screen takeoff with rAF + auto
//     input-attach + Time resource (feat-20260518-app-shell-game-loop).
//   - HANDLE_SPHERE + HANDLE_CUBE -- builtin mesh handles with
//     default-standard-pbr material and emissiveIntensity > 1.0 to
//     drive HDR-bright pixels above the bloom threshold.
//   - Space toggle runtime: reads InputSnapshot.keyboard.down(' '),
//     derives a press-edge from prev-frame level tracking, toggles
//     Camera.bloom between BLOOM_DISABLED and BLOOM_ENABLED via
//     world.set(camEntity, Camera, { bloom }). The engine extract
//     stage re-reads bloom every frame (zero engine-side code change).
//   - DOM HUD overlay (charter F2 text over image): #bloom-hud span
//     updates textContent to "Bloom: ON" / "Bloom: OFF" on every toggle.
//   - Tonemap: TONEMAP_REINHARD_EXTENDED -- HDR target must be active
//     for bloom to operate (bloom gate requires tonemapActive=true).
//
// Scene: emissive sphere + cube under a slant directional light. The
// sphere has emissiveIntensity=2.0 to produce pixels >1.0 in HDR that
// the bloom bright-pass extracts. The cube has emissiveIntensity=0.5
// to stay below the default 1.0 threshold.
//
// Recipe (charter P1 progressive disclosure):
//   (1) createApp(canvas, {}, { shaderManifestUrl }) + spawn Camera with clear* fields
//   (2) define the 5 standard components via defineComponent (globally live)
//   (3) assets.register<MaterialAsset>(standard PBR) -> materialHandle for non-emissive
//   (4) assets.register<MaterialAsset>(standard PBR emissive) -> emissiveHandle for emissive
//   (5) world.spawn emissive sphere + cube, DirectionalLight, Camera (save entity)
//   (6) world.addSystem press-edge toggle + HUD sync
//   (7) app.start()

import { createApp } from '@forgeax/engine-app';
import type { CanvasAppError } from '@forgeax/engine-app';

import {
  BLOOM_DISABLED,
  BLOOM_ENABLED,
  Camera,
  DirectionalLight,
  EngineEnvironmentError,
  HANDLE_CUBE,
  HANDLE_SPHERE,
  MeshFilter,
  MeshRenderer,
  perspective,
  TONEMAP_REINHARD_EXTENDED,
  Transform,
} from '@forgeax/engine-runtime';

import type { Handle, MaterialAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error('[bloom] missing <canvas id="app"> in index.html');
}

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[bloom] EngineEnvironmentError: webgpu inner=${code}`);
  } else {
    console.error('[bloom] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  // Step 1: createApp(canvas, opts) -- one-screen takeoff.
  const appRes = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appRes.ok) {
    reportAppError(appRes.error);
    return;
  }
  const app = appRes.value;
  console.warn(`[bloom] backend=${app.renderer.backend}`);

  const ready = await app.renderer.ready;
  if (!ready.ok) {
    console.error('[bloom] renderer.ready failed:', ready.error.code, ready.error.hint);
    return;
  }

  const assets = app.renderer.assets;
  if (assets === null) {
    console.error(
      '[bloom] AssetRegistry is null (renderer construction did not complete successfully)',
    );
    return;
  }

  // Step 2: register standard PBR material for non-emissive geometry.
  const matRes = assets.register<MaterialAsset>({
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::default-standard-pbr',
        tags: { LightMode: 'Forward' },
        queue: 2000,
      },
    ],
    paramValues: {
      baseColor: [0.7, 0.7, 0.7],
      metallic: 0.0,
      roughness: 0.4,
    },
  });
  if (!matRes.ok) {
    console.error('[bloom] material register failed:', matRes.error.code);
    return;
  }
  const materialHandle: Handle<'MaterialAsset', 'unmanaged'> = matRes.value;

  // Step 3: register emissive PBR material (emissiveIntensity > 1.0).
  // The default-standard-pbr emissive factor produces >1.0 HDR values
  // that the bloom bright-pass extracts (threshold 1.0).
  const emissiveRes = assets.register<MaterialAsset>({
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::default-standard-pbr',
        tags: { LightMode: 'Forward' },
        queue: 2000,
      },
    ],
    paramValues: {
      baseColor: [1.0, 0.85, 0.55],
      metallic: 0.0,
      roughness: 0.3,
      emissive: [1.0, 0.7, 0.3],
      emissiveIntensity: 2.0,
    },
  });
  if (!emissiveRes.ok) {
    console.error('[bloom] emissive material register failed:', emissiveRes.error.code);
    return;
  }
  const emissiveHandle: Handle<'MaterialAsset', 'unmanaged'> = emissiveRes.value;

  // Step 4: register the 5 standard components.
  const world = app.world;

  // Step 5: spawn emissive sphere (left) and non-emissive cube (right).
  // The sphere produces HDR-bright pixels for bloom; the cube stays
  // below threshold as a visual reference.
  world.spawn(
    {
      component: Transform,
      data: {
        posX: -0.6,
        posY: 0.2,
        posZ: 0,
        quatW: 1,
        scaleX: 0.6,
        scaleY: 0.6,
        scaleZ: 0.6,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
    { component: MeshRenderer, data: { materials: [emissiveHandle] } },
  ).unwrap();

  world.spawn(
    {
      component: Transform,
      data: {
        posX: 0.6,
        posY: 0,
        posZ: 0,
        quatW: 1,
        scaleX: 0.4,
        scaleY: 0.4,
        scaleZ: 0.4,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  ).unwrap();

  // Step 6: spawn directional light with slant direction.
  world.spawn({
    component: DirectionalLight,
    data: {
      directionX: -0.4,
      directionY: -0.6,
      directionZ: -0.7,
      colorR: 1,
      colorG: 1,
      colorB: 1,
      intensity: 1.5,
    },
  }).unwrap();

  // Step 7: spawn camera with tonemap=Reinhard-Extended (HDR path
  // required for bloom) and bloom=DISABLED (zero-overhead default).
  const camEntity = world.spawn(
    {
      component: Transform,
      data: { posZ: 5 },
    },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }),
        tonemap: TONEMAP_REINHARD_EXTENDED,
        bloom: BLOOM_DISABLED,
        bloomThreshold: 1.0,
        bloomIntensity: 1.0,
        bloomBlurRadius: 4.0,
      },
    },
  ).unwrap();

  // Step 8: Space-key press-edge toggle system.
  // InputSnapshot.keyboard matches KeyboardEvent.key (browser backend
  // stores ev.key), so the spacebar is the literal ' ' -- NOT 'Space'
  // (that is ev.code). See packages/input/src/input-snapshot.ts down() doc.
  let prevSpace = false;
  let currentBloom: number = BLOOM_DISABLED;

  const hudEl = document.getElementById('bloom-hud');

  world.addSystem({
    name: 'bloom-space-toggle',
    after: ['input-frame-start-scan'],
    queries: [],
    fn: () => {
      const snap = app.renderer.input.snapshot(world);
      if (snap === undefined) return;

      const cur = snap.keyboard.down(' ');
      if (cur && !prevSpace) {
        const target =
          currentBloom === BLOOM_ENABLED ? BLOOM_DISABLED : BLOOM_ENABLED;
        const setRes = world.set(camEntity, Camera, { bloom: target });
        if (setRes.ok) {
          currentBloom = target;
          if (hudEl) {
            hudEl.textContent =
              target === BLOOM_ENABLED ? 'Bloom: ON' : 'Bloom: OFF';
          }
        } else {
          console.error('[bloom] toggle world.set failed:', setRes.error.code);
        }
      }
      prevSpace = cur;
    },
  });

  // Step 9: arm the rAF loop.
  const startRes = app.start();
  if (!startRes.ok) {
    reportAppError(startRes.error);
    return;
  }
  console.warn('[bloom] running. Press Space to toggle Bloom.');
}

function reportAppError(err: CanvasAppError | EngineEnvironmentError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[bloom] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[bloom] ${err.code}: ${err.hint}`);
}