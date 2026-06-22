#!/usr/bin/env node
// apps/learn-render/5.advanced-lighting/6.hdr/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 5.6 - HDR dawn-node smoke.
// Structural-only: registers two custom RenderPipeline (HDR exposure +
// LDR passthrough), drives >=150 frames per mode (>=300 total),
// asserts perFramePassNames is exactly ['main', 'postHdr'] and
// onError == 0.
//
// FALSIFY mode (env FORGEAX_LEARN_RENDER_5_6_HDR_SMOKE_FALSIFY=1):
// skips installPipeline so the URP default 9-pass chain runs instead;
// perFramePassNames will not match ['main', 'postHdr'] and the smoke
// MUST exit with [smoke] FAIL. Plan-decisions D-5(a) / plan-strategy
// section 5.4: implement the falsification check, not just the
// confirmation.
//
// Output literals (preserved for grep tooling):
//   - `[learn-render-6-hdr] backend=<backend>`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] PASS`
//   - `[smoke] FAIL`

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const PER_MODE_FRAMES = Math.max(150, Math.ceil(SMOKE_MIN_FRAMES / 2));
const WIDTH = 512;
const HEIGHT = 512;

const FALSIFY = process.env.FORGEAX_LEARN_RENDER_5_6_HDR_SMOKE_FALSIFY === '1';

const hereDir = fileURLToPath(import.meta.url).replace(/\/[^/]+$/, '');
const APP_ROOT = resolve(hereDir, '..');
const MONOREPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');
const TEXTURES_DIR = resolve(MONOREPO_ROOT, 'forgeax-engine-assets', 'learn-opengl', 'textures');
const WOOD_SRC_PATH = resolve(TEXTURES_DIR, 'wood.png');

const WOOD_GUID_STR = '019e3969-1d48-7c3b-ac24-6d68f457065f';

// Mirror src/index.ts inline WGSL (kept in sync by hand). Grep
// `exp(-hdrColor * exposure)` finds both src/index.ts and this smoke.
const HDR_LO_EXPOSURE_WGSL = `
struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) i : u32) -> FullscreenOutput {
  var x : f32 = -1.0; var y : f32 = -1.0;
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
const HDR_PASSTHROUGH_WGSL = `
struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) i : u32) -> FullscreenOutput {
  var x : f32 = -1.0; var y : f32 = -1.0;
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

// --- 1. dawn.node binding setup ---

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-5-advanced-lighting-6-hdr' smoke",
  );
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}
let gpu;
try {
  gpu = create([]);
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  hint:  on linux ensure libvulkan1 + mesa-vulkan-drivers installed');
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', {
  value: gpu,
  configurable: true,
  writable: true,
});
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalAmbientRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
  globalThis.navigator.gpu,
);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const rawAdapter = await originalAmbientRequestAdapter(opts);
  if (rawAdapter === null) return rawAdapter;
  const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
  rawAdapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return rawAdapter;
};

// --- 2. Mock canvas with offscreen render target ---

let renderTarget;
function ensureRenderTarget(device, format) {
  if (renderTarget) return renderTarget;
  renderTarget = device.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  return renderTarget;
}

const mockCanvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm');
      },
      unconfigure() {},
      getCurrentTexture() {
        if (!renderTarget) {
          if (!sharedDevice) throw new Error('no shared device captured');
          ensureRenderTarget(sharedDevice, 'rgba8unorm');
        }
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

// --- 3. Asset fixture check ---

if (!existsSync(WOOD_SRC_PATH)) {
  console.error(`[smoke] FAIL - asset fixture missing: ${WOOD_SRC_PATH}`);
  console.error(
    '  rerun: git submodule update --init --recursive (forgeax-engine-assets submodule must be checked out)',
  );
  process.exit(1);
}

// --- 4. Decode texture + create renderer ---

const { World } = await import('@forgeax/engine-ecs');
const { decodeImageFromFile } = await import('@forgeax/engine-image/decode-image-from-file');
const enginePkg = await import('@forgeax/engine-runtime');
const {
  addFullscreenPass,
  addScenePass,
  Camera,
  createRenderer,
  HANDLE_CUBE,
  MeshFilter,
  MeshRenderer,
  PointLight,
  TONEMAP_REINHARD_EXTENDED,
  Transform,
} = enginePkg;
const { unwrapHandle } = await import('@forgeax/engine-types');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');
const { RenderGraph } = await import('@forgeax/engine-render-graph');

const woodDecodeRes = await decodeImageFromFile(WOOD_SRC_PATH);
if (!woodDecodeRes.ok) {
  console.error('[smoke] FAIL - decodeImageFromFile failed:', woodDecodeRes.error.code);
  process.exit(1);
}
const { decoded: woodDecoded } = woodDecodeRes.value;
console.log(
  `[learn-render-6-hdr] decoded wood=${woodDecoded.width}x${woodDecoded.height} ${woodDecoded.mime}`,
);

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const MANIFEST_URL = `data:application/json,${encodeURIComponent(JSON.stringify(ENGINE_MANIFEST))}`;

let renderer;
try {
  renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
} catch (err) {
  console.error(
    `[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

console.log(`[learn-render-6-hdr] backend=${renderer.backend}`);

const assets = renderer.assets;
if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

const errors = [];
renderer.onError((err) => errors.push({ code: err.code, hint: err.hint }));

const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready failed: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

// Register wood texture under its GUID.
const woodGuidRes = AssetGuid.parse(WOOD_GUID_STR);
if (!woodGuidRes.ok) {
  console.error('[smoke] FAIL - GUID parse failed');
  process.exit(1);
}
const woodTexAsset = {
  kind: 'texture',
  width: woodDecoded.width,
  height: woodDecoded.height,
  format: woodDecoded.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
  data: woodDecoded.bytes,
  colorSpace: woodDecoded.colorSpace,
  mipmap: woodDecoded.mipmap,
};
const world = new World();

// Catalogue the wood texture under its GUID, then mint a shared-ref column handle.
assets.catalog(woodGuidRes.value, woodTexAsset);
const woodHandle = world.allocSharedRef('TextureAsset', woodTexAsset);

const tunnelMat = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      shader: 'forgeax::default-standard-pbr',
      tags: { LightMode: 'Forward' },
    },
  ],
  paramValues: {
    baseColor: [1.0, 1.0, 1.0, 1.0],
    metallic: 0.0,
    roughness: 0.85,
    baseColorTexture: unwrapHandle(woodHandle),
  },
});

const strongMat = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      shader: 'forgeax::default-standard-pbr',
      tags: { LightMode: 'Forward' },
    },
  ],
  paramValues: {
    baseColor: [1.0, 1.0, 1.0, 1.0],
    metallic: 0.0,
    roughness: 0.4,
    emissive: [1.0, 1.0, 1.0],
    emissiveIntensity: 4.0,
  },
});

// Tunnel
world
  .spawn(
    {
      component: Transform,
      data: {
        posX: 0, posY: 0, posZ: -25,
        quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
        scaleX: 5, scaleY: 5, scaleZ: 50,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [tunnelMat] } },
  )
  .unwrap();

// Strong light at far end
world
  .spawn(
    {
      component: Transform,
      data: {
        posX: 0, posY: 0, posZ: -45,
        quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
        scaleX: 0.25, scaleY: 0.25, scaleZ: 0.25,
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
      posX: 0, posY: 0, posZ: -45,
      quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
      scaleX: 1, scaleY: 1, scaleZ: 1,
    },
  },
  { component: PointLight, data: {} },
);

// Camera
world.spawn(
  {
    component: Transform,
    data: {
      posX: 0, posY: 0, posZ: 0,
      quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
      scaleX: 1, scaleY: 1, scaleZ: 1,
    },
  },
  {
    component: Camera,
    data: {
      fov: Math.PI / 4,
      aspect: WIDTH / HEIGHT,
      near: 0.1,
      far: 100,
      tonemap: TONEMAP_REINHARD_EXTENDED,
    },
  },
);

// --- 5. Register two custom RenderPipelines + their assets ---

const HDR_EXPOSURE_POSTPROCESS_ID = 'learn-render::5-6-hdr-lo-exposure';
const HDR_PASSTHROUGH_POSTPROCESS_ID = 'learn-render::5-6-hdr-passthrough';
const HDR_PIPELINE_ID = 'learn-render-5-6-hdr::hdr';
const LDR_PIPELINE_ID = 'learn-render-5-6-hdr::ldr';

const OFFSCREEN_HDR_KEY = 'offscreenHdr';
const OFFSCREEN_DEPTH_KEY = 'hdrDepth';

function makeHdrPipeline(mode) {
  return {
    buildGraph(ctx) {
      const graph = new RenderGraph();
      graph.addColorTarget(OFFSCREEN_HDR_KEY, {
        format: 'rgba16float',
        size: 'swapchain',
        sample: 1,
        usage: 0x10 | 0x04,
      });
      graph.addColorTarget(OFFSCREEN_DEPTH_KEY, {
        format: 'depth24plus-stencil8',
        size: 'swapchain',
        sample: 1,
        usage: 0x10,
      });
      addScenePass(graph, 'main', {
        color: OFFSCREEN_HDR_KEY,
        depth: OFFSCREEN_DEPTH_KEY,
        selector: { LightMode: ['Forward'] },
        _routeFromOpts: true,
      });
      const postShaderId =
        mode === 'hdr' ? HDR_EXPOSURE_POSTPROCESS_ID : HDR_PASSTHROUGH_POSTPROCESS_ID;
      addFullscreenPass(graph, 'postHdr', {
        shader: postShaderId,
        color: 'swapchain',
        reads: [OFFSCREEN_HDR_KEY],
      });
      const compileResult = graph.compile({
        backendKind: ctx.runtime.device.caps.backendKind,
        caps: ctx.runtime.device.caps,
        device: ctx.runtime.device,
      });
      if (!compileResult.ok) return null;
      return graph;
    },
    execute(ctx) {
      ctx.frameState.perFrameGraph?.execute(ctx);
    },
  };
}

try {
  renderer.postProcess.register(HDR_EXPOSURE_POSTPROCESS_ID, {
    source: HDR_LO_EXPOSURE_WGSL,
    reads: [OFFSCREEN_HDR_KEY],
  });
  renderer.registerPipeline(HDR_PIPELINE_ID, makeHdrPipeline('hdr'));
  renderer.postProcess.register(HDR_PASSTHROUGH_POSTPROCESS_ID, {
    source: HDR_PASSTHROUGH_WGSL,
    reads: [OFFSCREEN_HDR_KEY],
  });
  renderer.registerPipeline(LDR_PIPELINE_ID, makeHdrPipeline('ldr'));
} catch (e) {
  console.error('[smoke] FAIL - register threw:', e instanceof Error ? e.message : String(e));
  process.exit(1);
}

// --- 6. Install HDR pipeline + drive frames; then swap to LDR ---

if (!FALSIFY) {
  const installHdr = renderer.installPipeline({
    kind: 'render-pipeline',
    pipelineId: HDR_PIPELINE_ID,
  });
  if (!installHdr.ok) {
    console.error(`[smoke] FAIL - installPipeline(hdr): ${installHdr.error.code}`);
    process.exit(1);
  }
} else {
  console.warn(
    '[learn-render-6-hdr] FALSIFY mode: skipping installPipeline (URP default 9-pass chain runs)',
  );
}

const frameStart = Date.now();
let framesObserved = 0;
for (let i = 0; i < PER_MODE_FRAMES; i++) {
  world.update();
  const r = renderer.draw(world);
  if (!r.ok) console.error(`[smoke] draw hdr frame ${i} error: ${r.error.code}`);
  framesObserved++;
}

if (!FALSIFY) {
  const installLdr = renderer.installPipeline({
    kind: 'render-pipeline',
    pipelineId: LDR_PIPELINE_ID,
  });
  if (!installLdr.ok) {
    console.error(`[smoke] FAIL - installPipeline(ldr): ${installLdr.error.code}`);
    process.exit(1);
  }
}

for (let i = 0; i < PER_MODE_FRAMES; i++) {
  world.update();
  const r = renderer.draw(world);
  if (!r.ok) console.error(`[smoke] draw ldr frame ${i} error: ${r.error.code}`);
  framesObserved++;
}

// Capture perFramePassNames BEFORE app.stop() (research F-7 hard rule).
const passNames = renderer.perFramePassNames;

const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
const frameWall = Date.now() - frameStart;
console.log(
  `[smoke] frames observed=${framesObserved} (wall=${frameWall}ms, per-mode=${PER_MODE_FRAMES})`,
);

// --- 7. Verdict (structural-only) ---

const wallTotalMs = Date.now() - frameStart;
console.log(`[smoke] wallTotalMs=${wallTotalMs}`);
console.log(`[smoke] perFramePassNames=[${passNames.join(', ')}]`);

const failures = [];
if (renderer.backend !== 'webgpu')
  failures.push(`(a) backend=${renderer.backend} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES)
  failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(c) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

const expectedPassNames = ['main', 'postHdr'];
const passNamesEqual =
  passNames.length === expectedPassNames.length &&
  passNames.every((n, i) => n === expectedPassNames[i]);
if (!passNamesEqual) {
  failures.push(
    `(d) perFramePassNames=[${passNames.join(', ')}] (expected [${expectedPassNames.join(', ')}])`,
  );
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-5-advanced-lighting-6-hdr' smoke",
  );
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 4 criteria GREEN: backend=webgpu, frames=${framesObserved}, RhiError count=0, perFramePassNames=[main, postHdr], wallTotalMs=${wallTotalMs}`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
