// apps/learn-render/5.advanced-lighting/6.hdr/src/index.ts
// LearnOpenGL section 5.6 - HDR.
//
// Two RenderPipelineAsset PODs, hot-swapped via `renderer.installPipeline`:
//   key '1' -> HDR pipeline (rgba16float offscreen + LO exposure tonemap)
//   key '2' -> LDR pipeline (rgba16float offscreen + passthrough; burns to
//                            white because the swap-chain rgba8unorm-srgb
//                            store clamps > 1.0 values to 1.0 -> the
//                            canonical LearnOpenGL 5.6 LDR teaching artefact)
//
// t9 spike: minimal scene (single cube) with the rgba16float offscreen +
// `_routeFromOpts: true` combination wired through the full five-step chain
// (postProcess.register x2 -> registerPipeline x2 -> assets.register x2 ->
// installPipeline). t11 will expand to the full LO 5.6 tunnel + 4 lights.
//
// GREP anchors for AI users:
//   - "// 1. engine usage"            public engine API consumed
//   - "// 2. example-specific glue"   LO 5.6 scene constants + WGSL + chain
//   - "// 3. bootstrap"               entry point wiring + keydown HUD

// 1. engine usage
import { createApp } from '@forgeax/engine-app';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  Camera,
  HANDLE_CUBE,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  TONEMAP_REINHARD_EXTENDED,
  Transform,
  createDevImportTransport,
  perspective,
} from '@forgeax/engine-runtime';
import type { MaterialAsset, RenderPipelineAsset, TextureAsset } from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';
import {
  HDR_EXPOSURE_POSTPROCESS_ID,
  HDR_PASSTHROUGH_POSTPROCESS_ID,
  HDR_PIPELINE_ID,
  LDR_PIPELINE_ID,
  hdrDisplayNameByKey,
  installHdrPipelineByKey,
  makeHdrPipeline,
  setHdrPipelineRegistryForTest,
} from './hdr-pipeline';

// 2. example-specific glue

const PACK_INDEX_URL = '/pack-index.json';

// LO exposure default value (LearnOpenGL section 5.6, default exposure=1.0).
// Grep-able constant so AI users land on the per-pixel exposure scalar.
const LO_EXPOSURE = 1.0;

// Texture GUID from forgeax-engine-assets/learn-opengl/textures/wood.png.meta.json
// Wood floor + walls cover the LO tunnel interior.
const WOOD_GUID_STR = '019e3969-1d48-7c3b-ac24-6d68f457065f';

// LO 5.6 tunnel geometry. The LearnOpenGL HDR scene is a long
// rectangular corridor with a bright light at the far end + three weak
// coloured lights along the depth -- bright values exceed 1.0 in the
// rgba16float offscreen, exposing the LDR clamp under '2' and the LO
// exposure tonemap recovery under '1'.
const TUNNEL_SCALE_X = 5.0;
const TUNNEL_SCALE_Y = 5.0;
const TUNNEL_SCALE_Z = 50.0;
const TUNNEL_POS_Z = -25.0;

// 4 lights along the tunnel depth (z=0 = entrance, z=-50 = far end).
//   bright white at the far end (intensity=4.0; emissiveIntensity ratio
//   to the dim lights = 4.0/0.5 = 8x; plan-decisions D-3 floor was 25x
//   on the strong-light intensity scalar; PointLight intensity here is
//   left at engine default and the brightness comes from the emissive
//   light-box surface; the strength ratio between strong vs weak
//   light-box emissive intensity -- 4.0 vs 0.5 -- is the AI-grep target).
const STRONG_LIGHT_EMISSIVE_INTENSITY = 4.0;
const WEAK_LIGHT_EMISSIVE_INTENSITY = 0.5;

// Light positions (LO layout: one strong at far end + three weak fanned
// across the tunnel, each visible as a small emissive cube box).
const STRONG_LIGHT_POS: readonly [number, number, number] = [0.0, 0.0, -45.0];
const WEAK_LIGHT_POSITIONS: ReadonlyArray<readonly [number, number, number]> = [
  [-1.4, -1.9, -9.0],
  [0.0, -1.8, -4.0],
  [0.8, -1.7, -6.0],
];

// Light box (cube scaled small to visualise each PointLight).
const LIGHT_BOX_SCALE = 0.25;

// Strong light is white; weak lights are saturated R/G/B for visual
// distinction (LearnOpenGL uses similar coloured fills along the tunnel).
const STRONG_LIGHT_COLOR: readonly [number, number, number] = [1.0, 1.0, 1.0];
const WEAK_LIGHT_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [1.5, 0.0, 0.0], // red
  [0.0, 1.5, 0.0], // green
  [0.0, 0.0, 1.5], // blue
];

// First-person camera entry pose: looking down the tunnel along -Z.
const CAMERA_POS_X = 0.0;
const CAMERA_POS_Y = 0.0;
const CAMERA_POS_Z = 0.0;
const CAMERA_FOV = Math.PI / 4;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100.0;

// HDR (LO exposure tonemap) fragment shader. Implements the canonical
// LearnOpenGL section 5.6 equation:
//   mapped = 1.0 - exp(-hdrColor * exposure)
// (LearnOpenGL HDR chapter, https://learnopengl.com/Advanced-Lighting/HDR).
//
// AI-user teaching path:
//   1. The scene renders into 'offscreenHdr' (rgba16float) so per-channel
//      values can exceed 1.0 (bright lights are encoded raw).
//   2. This fullscreen pass samples that HDR target and folds the
//      exponential exposure tonemap; result is a [0..1] linear value
//      ready for the swap-chain.
//   3. The swap-chain 'rgba8unorm-srgb' view HW-encodes linear -> sRGB
//      on store. We deliberately do NOT apply pow(1/2.2) here -- doing
//      so would double-encode and produce a too-bright image. The
//      gamma-correction sibling demo 5.2 covers the gamma teaching
//      path explicitly (per plan-decisions D-7: this demo's job is the
//      HDR exposure curve, not the gamma encode).
//
// Forgeax production-grade equivalent: declare `Camera.tonemap =
// TONEMAP_REINHARD_EXTENDED` and let the URP default pipeline run
// `packages/shader/src/tonemap.wgsl`. This demo hand-rolls a tiny LO
// exposure tonemap so the teaching equation `exp(-hdrColor * exposure)`
// is grep-able alongside the per-mode pipeline registration (AC-11 anchor).
// The 7.bloom sibling demo (in this same feat) shows the production-grade
// `Camera.tonemap = TONEMAP_REINHARD_EXTENDED` field-driven path.
const HDR_LO_EXPOSURE_WGSL = `
struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) i : u32) -> FullscreenOutput {
  var x : f32 = -1.0;
  var y : f32 = -1.0;
  if (i == 1u) { x = 3.0; }
  if (i == 2u) { y = 3.0; }
  let u : f32 = (x + 1.0) * 0.5;
  let v : f32 = 1.0 - (y + 1.0) * 0.5;
  var out : FullscreenOutput;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(u, v);
  return out;
}

@group(1) @binding(0) var hdrTexture : texture_2d<f32>;
@group(1) @binding(1) var hdrSampler : sampler;

@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let exposure : f32 = 1.0;
  let hdrColor = textureSample(hdrTexture, hdrSampler, in.uv).rgb;
  let mapped = vec3<f32>(1.0, 1.0, 1.0) - exp(-hdrColor * exposure);
  return vec4<f32>(mapped, 1.0);
}
`;

// LDR passthrough fragment shader. Reads the rgba16float offscreen and
// writes raw RGB to the swap-chain unchanged.
//
// LDR teaching artefact (intentional, plan-decisions D-1):
// values exceeding 1.0 in the rgba16float HDR offscreen stay raw through
// this passthrough; the swap-chain 'rgba8unorm-srgb' view's u8 store
// clamps `>1.0` channels to 1.0 (pure white) before the HW sRGB encode.
// This is the canonical LearnOpenGL 5.6 "burn to white" image: AI users
// press '2' to see HDR detail vanish into white blowouts where bright
// lights live, then press '1' to see exp(-hdrColor * exposure) recover
// shadow + highlight detail in one step.
const HDR_PASSTHROUGH_WGSL = `
struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) i : u32) -> FullscreenOutput {
  var x : f32 = -1.0;
  var y : f32 = -1.0;
  if (i == 1u) { x = 3.0; }
  if (i == 2u) { y = 3.0; }
  let u : f32 = (x + 1.0) * 0.5;
  let v : f32 = 1.0 - (y + 1.0) * 0.5;
  var out : FullscreenOutput;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(u, v);
  return out;
}

@group(1) @binding(0) var hdrTexture : texture_2d<f32>;
@group(1) @binding(1) var hdrSampler : sampler;

@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let hdrColor = textureSample(hdrTexture, hdrSampler, in.uv).rgb;
  return vec4<f32>(hdrColor, 1.0);
}
`;

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 5.6 hdr] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() },
  );
  if (!appRes.ok) {
    console.error('[learn-render 5.6 hdr] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const renderer = app.renderer;
  const world = app.world;
  app.onError((error) => {
    console.error('[learn-render 5.6 hdr] app.onError:', error.code, error.hint);
    const bus = (
      globalThis as unknown as {
        __learnRenderErrors?: Array<{ code: string; hint?: string }>;
      }
    ).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });

  const assets = renderer.assets;
  assets.configurePackIndex(PACK_INDEX_URL);

  // Wood texture for the tunnel walls + floor (HANDLE_CUBE inside-out).
  const woodGuidRes = AssetGuid.parse(WOOD_GUID_STR);
  if (!woodGuidRes.ok) {
    console.error('[learn-render 5.6 hdr] wood GUID parse failed');
    return;
  }
  const woodTexRes = await assets.loadByGuid<TextureAsset>(woodGuidRes.value);
  if (!woodTexRes.ok) {
    console.error('[learn-render 5.6 hdr] wood loadByGuid failed:', woodTexRes.error.code);
    return;
  }
  const woodTex = woodTexRes.value;

  // Tunnel material: standard PBR wood baseColor, matte finish (rough +
  // non-metal) so the bright lights paint clear specular highlights.
  const tunnelMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({
      baseColor: [1.0, 1.0, 1.0, 1.0],
      roughness: 0.85,
      metallic: 0.0,
      baseColorTexture: unwrapHandle(world.allocSharedRef('TextureAsset', woodTex)),
    }),
  );

  // Tunnel = HANDLE_CUBE scaled long along Z. Camera sits inside; back-
  // face culling plus the inside-out scale makes the cube interior the
  // visible scene (LO 5.6 corridor).
  world
    .spawn(
      {
        component: Transform,
        data: {
          posX: 0,
          posY: 0,
          posZ: TUNNEL_POS_Z,
          scaleX: TUNNEL_SCALE_X,
          scaleY: TUNNEL_SCALE_Y,
          scaleZ: TUNNEL_SCALE_Z,
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [tunnelMat] } },
    )
    .unwrap();

  // Strong white light at the far end of the tunnel. emissiveIntensity =
  // 4.0 -> per-channel emissive output substantially exceeds 1.0, which
  // is the whole point of HDR (rgba16float offscreen preserves the
  // signal; LDR passthrough clamps it; LO exposure tonemaps it).
  const strongMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({
      baseColor: [1.0, 1.0, 1.0, 1.0],
      roughness: 0.4,
      emissive: STRONG_LIGHT_COLOR,
      emissiveIntensity: STRONG_LIGHT_EMISSIVE_INTENSITY,
    }),
  );
  world
    .spawn(
      {
        component: Transform,
        data: {
          posX: STRONG_LIGHT_POS[0],
          posY: STRONG_LIGHT_POS[1],
          posZ: STRONG_LIGHT_POS[2],
          scaleX: LIGHT_BOX_SCALE,
          scaleY: LIGHT_BOX_SCALE,
          scaleZ: LIGHT_BOX_SCALE,
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [strongMat] } },
    )
    .unwrap();
  world.spawn(
    {
      component: Transform,
      data: {
        posX: STRONG_LIGHT_POS[0],
        posY: STRONG_LIGHT_POS[1],
        posZ: STRONG_LIGHT_POS[2],
      },
    },
    { component: PointLight, data: {} },
  );

  // Three weak coloured lights along the tunnel depth (R/G/B). Each
  // emissiveIntensity = 0.5 stays under 1.0, so the LDR mode preserves
  // colour but loses bright-end detail at the strong light only.
  for (let i = 0; i < WEAK_LIGHT_POSITIONS.length; i++) {
    const pos = WEAK_LIGHT_POSITIONS[i];
    const color = WEAK_LIGHT_COLORS[i];
    if (pos === undefined || color === undefined) continue;
    const weakMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
      'MaterialAsset',
      Materials.standard({
        baseColor: [1.0, 1.0, 1.0, 1.0],
        roughness: 0.4,
        emissive: color,
        emissiveIntensity: WEAK_LIGHT_EMISSIVE_INTENSITY,
      }),
    );
    world
      .spawn(
        {
          component: Transform,
          data: {
            posX: pos[0],
            posY: pos[1],
            posZ: pos[2],
            scaleX: LIGHT_BOX_SCALE,
            scaleY: LIGHT_BOX_SCALE,
            scaleZ: LIGHT_BOX_SCALE,
          },
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [weakMat] } },
      )
      .unwrap();
    world.spawn(
      {
        component: Transform,
        data: { posX: pos[0], posY: pos[1], posZ: pos[2] },
      },
      { component: PointLight, data: {} },
    );
  }

  // Camera. `tonemap = TONEMAP_REINHARD_EXTENDED` declares the HDR
  // geometry pipeline variant (plan-decisions D-2): in this demo we run
  // a custom RenderPipeline so the engine's URP tonemap pass does NOT
  // execute -- the only effect of this field is to flip the geometry
  // pipeline-variant cache to the HDR side (rgba16float-compatible
  // standard PBR variant). The actual tonemap is the LO exposure
  // fragment registered via postProcess.register below.
  //
  // bloom is intentionally OMITTED from the Camera spawn data (plan-
  // decisions D-7): our custom RenderPipeline does not emit the URP
  // bloom pass chain, so declaring `bloom = BLOOM_ENABLED` here would
  // be a phantom field. Compare with 7.bloom which does the opposite:
  // declares `bloom = BLOOM_ENABLED` to opt into the URP bloom chain
  // *because* it consumes the URP default pipeline.
  const cameraEntity = world
    .spawn(
      {
        component: Transform,
        data: { posX: CAMERA_POS_X, posY: CAMERA_POS_Y, posZ: CAMERA_POS_Z },
      },
      {
        component: Camera,
        data: {
          ...perspective({
            fov: CAMERA_FOV,
            aspect: target.width / target.height,
            near: CAMERA_NEAR,
            far: CAMERA_FAR,
          }),
          tonemap: TONEMAP_REINHARD_EXTENDED,
        },
      },
    )
    .unwrap();

  // First-person controls so AI users can walk down the tunnel and
  // compare HDR vs LDR detail at different distances from the strong
  // light.
  addFirstPersonSystem(app.world, app.renderer, {
    name: 'learn-render-5.6-first-person',
    overrideBackend: undefined,
  });

  // Five-step chain (mirrors gamma-correction 5.2 idiom):
  //   1. postProcess.register(SHADER_ID, { source, reads })  x 2
  //   2. registerPipeline(PIPELINE_ID, makeHdrPipeline(mode)) x 2
  //   3. build RenderPipelineAsset POD                         x 2
  //   4. installPipeline(initialAsset)                        boot default
  //   5. window keydown 1/2 -> installHdrPipelineByKey
  try {
    renderer.postProcess.register(HDR_EXPOSURE_POSTPROCESS_ID, {
      source: HDR_LO_EXPOSURE_WGSL,
      reads: ['offscreenHdr'],
    });
    renderer.registerPipeline(HDR_PIPELINE_ID, makeHdrPipeline('hdr'));
    renderer.postProcess.register(HDR_PASSTHROUGH_POSTPROCESS_ID, {
      source: HDR_PASSTHROUGH_WGSL,
      reads: ['offscreenHdr'],
    });
    renderer.registerPipeline(LDR_PIPELINE_ID, makeHdrPipeline('ldr'));
  } catch (e) {
    console.error('[learn-render 5.6 hdr] register threw:', e);
    return;
  }

  const hdrAsset: RenderPipelineAsset = {
    kind: 'render-pipeline',
    pipelineId: HDR_PIPELINE_ID,
  };
  const ldrAsset: RenderPipelineAsset = {
    kind: 'render-pipeline',
    pipelineId: LDR_PIPELINE_ID,
  };

  setHdrPipelineRegistryForTest({
    assetsByKey: new Map([
      ['1', hdrAsset],
      ['2', ldrAsset],
    ]),
    renderer,
  });

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 5.6 hdr] app.start failed:', startRes.error);
    return;
  }

  const initialInstall = installHdrPipelineByKey('1');
  if (!initialInstall.ok) {
    console.error(
      '[learn-render 5.6 hdr] initial installHdrPipelineByKey(1) failed:',
      initialInstall.error,
    );
    return;
  }

  window.addEventListener('resize', () => {
    const dpr = devicePixelRatio;
    target.width = window.innerWidth * dpr;
    target.height = window.innerHeight * dpr;
    world.set(cameraEntity, Camera, { aspect: window.innerWidth / window.innerHeight });
  });

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    let activeKey: '1' | '2' = '1';
    const hudElement = document.getElementById('hud');
    if (hudElement !== null) {
      hudElement.innerText = `hdr (exposure=${LO_EXPOSURE}) | press 1 = HDR, 2 = LDR`;
    }
    window.addEventListener('keydown', (event: KeyboardEvent) => {
      const key = event.key;
      if (key === activeKey) return;
      const installResult = installHdrPipelineByKey(key);
      if (!installResult.ok) {
        if (installResult.error.code === 'unknown-hdr-key') return;
        console.error(
          '[learn-render 5.6 hdr] installHdrPipelineByKey failed:',
          installResult.error,
        );
        return;
      }
      activeKey = key as '1' | '2';
      const displayName = hdrDisplayNameByKey(key);
      if (hudElement !== null && displayName !== null) {
        hudElement.innerText = `hdr: ${displayName} (exposure=${LO_EXPOSURE}) | press 1 = HDR, 2 = LDR`;
      }
    });
  }

  console.warn(`[learn-render 5.6 hdr] backend=${renderer.backend}`);
}

declare global {
  interface Window {
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}
