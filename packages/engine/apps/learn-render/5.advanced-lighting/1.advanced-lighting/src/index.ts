// apps/learn-render/5.advanced-lighting/1.advanced-lighting/src/index.ts
// LearnOpenGL section 5.1 - Blinn-Phong.
// Per-fragment Blinn-Phong shading via custom WGSL shader.
//
// Custom shader path (charter F1 grep gate):
//   grep `registerMaterialShader` -> finds this file
//   grep `learn-render::5-1-blinn-phong` -> finds WGSL + index.ts + meta.json
//
// MaterialAsset is constructed as a POJO directly (no Materials.standard())
// to demonstrate the raw asset shape for AI users.
//
// GREP anchors for AI users:
//   - "// 1. engine usage"    public engine API consumed
//   - "// 2. example glue"    LO 5.1 scene-specific constants + GUIDs
//   - "// 3. bootstrap"       entry point wiring (1)+(2)

// 1. engine usage
import { createApp } from '@forgeax/engine-app';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  Camera,
  createDevImportTransport,
  HANDLE_CUBE,
  MeshFilter,
  MeshRenderer,
  perspective,
  Transform,
} from '@forgeax/engine-runtime';
import type { MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';

import blinnPhongShader from './blinn-phong.wgsl';

const BLINN_PHONG_SHADER_ID = 'learn-render::5-1-blinn-phong' as const;

// 2. example glue

const PACK_INDEX_URL = '/pack-index.json';

// Texture GUID from forgeax-engine-assets/learn-opengl/textures/container2.png.meta.json
const CONTAINER2_GUID_STR = '019e3969-1d46-7945-a75a-ef97d537531e';

// Blinn-Phong constants (lightPos, lightColor, shininess) are baked into
// `blinn-phong.wgsl` as `const` because LO 5.1 never animates them.
// `viewPos` is read from the engine View UBO (`view.cameraPos`), which
// the engine fills from the active Camera transform every frame. User
// shaders cannot allocate additional @group(1) bindings above 6 — the
// engine reserves binding 7..17 for Skylight + emissive/AO (see
// `pbr-pipeline.ts buildPbrPipelineLayouts`).
const CAMERA_POS_Z = 3;
const CAMERA_FOV = Math.PI / 4;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100.0;

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 5.1 blinn-phong] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() },
  );
  if (!appRes.ok) {
    console.error('[learn-render 5.1 blinn-phong] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const renderer = app.renderer;
  const world = app.world;
  app.onError((error) => {
    console.error('[learn-render 5.1 blinn-phong] app.onError:', error.code, error.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });
  const assets = renderer.assets;

  // Wire the pack-index URL for GUID-based texture loading.
  assets.configurePackIndex(PACK_INDEX_URL);

  // Register the Blinn-Phong custom material shader. paramSchema is empty
  // because the WGSL inlines the LO 5.1 constants (no extra UBO required).
  const shader = renderer.shader;
  if (shader === null) {
    console.error('[learn-render 5.1 blinn-phong] renderer.shader is null');
    return;
  }
  shader.registerMaterialShader(BLINN_PHONG_SHADER_ID, {
    source: blinnPhongShader.wgsl,
    paramSchema: [{ name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] }],
  });

  // Parse texture GUID.
  const container2GuidRes = AssetGuid.parse(CONTAINER2_GUID_STR);
  if (!container2GuidRes.ok) {
    console.error('[learn-render 5.1 blinn-phong] GUID parse failed');
    return;
  }

  // Load texture through the GUID asset pipeline.
  const texRes = await assets.loadByGuid<TextureAsset>(container2GuidRes.value);
  if (!texRes.ok) {
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: texRes.error.code, hint: texRes.error.hint });
    console.error('[learn-render 5.1 blinn-phong] loadByGuid failed:', texRes.error.code);
    return;
  }
  const container2Tex = texRes.value;

  // Construct MaterialAsset POJO directly.
  const matRes = assets.register<MaterialAsset>({
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: BLINN_PHONG_SHADER_ID,
        tags: { LightMode: 'Forward' },
      },
    ],
    paramValues: {
      baseColorTexture: container2Tex,
    },
  });
  if (!matRes.ok) {
    console.error('[learn-render 5.1 blinn-phong] material register failed:', matRes.error);
    return;
  }
  const mat = matRes.value;

  // Spawn cube: HANDLE_CUBE is 1x1x1, centered at origin.
  world.spawn(
    { component: Transform, data: { posZ: 0 } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [mat] } },
  ).unwrap();

  // Camera at (0, 0, 3), FOV=45 deg.
  const cameraEntity = world.spawn(
    { component: Transform, data: { posZ: CAMERA_POS_Z } },
    {
      component: Camera,
      data: perspective({
        fov: CAMERA_FOV,
        aspect: target.width / target.height,
        near: CAMERA_NEAR,
        far: CAMERA_FAR,
      }),
    },
  ).unwrap();

  addFirstPersonSystem(app.world, app.renderer, {
    name: 'learn-render-5.1-first-person',
    overrideBackend: undefined,
  });

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 5.1 blinn-phong] app.start failed:', startRes.error);
    return;
  }

  window.addEventListener('resize', () => {
    const dpr = devicePixelRatio;
    target.width = window.innerWidth * dpr;
    target.height = window.innerHeight * dpr;
    world.set(cameraEntity, Camera, { aspect: window.innerWidth / window.innerHeight });
  });

  console.warn(`[learn-render 5.1 blinn-phong] backend=${renderer.backend}`);
}

declare global {
  interface Window {
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}