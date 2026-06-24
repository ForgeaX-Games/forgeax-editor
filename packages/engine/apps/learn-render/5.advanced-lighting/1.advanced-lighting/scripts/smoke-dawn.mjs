#!/usr/bin/env node
// apps/learn-render/5.advanced-lighting/1.advanced-lighting/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 5.advanced-lighting 1.advanced-lighting dawn-node smoke.
// Structural-only: >=60 frames, onError=0, no pixel readback.
//
// Output literals (preserved for grep tooling):
//   - `[learn-render-5-1-blinn-phong] backend=<backend>`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] PASS`
//   - `[smoke] FAIL`

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const WIDTH = 512;
const HEIGHT = 512;

const hereDir = fileURLToPath(import.meta.url).replace(/\/[^/]+$/, '');
const APP_ROOT = resolve(hereDir, '..');
const MONOREPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');
const TEXTURES_DIR = resolve(MONOREPO_ROOT, 'forgeax-engine-assets', 'learn-opengl', 'textures');
const CONTAINER2_SRC_PATH = resolve(TEXTURES_DIR, 'container2.png');

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
    "  rerun: pnpm --filter '@forgeax/app-learn-render-5-advanced-lighting-1-advanced-lighting' smoke",
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
// bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so this
// smoke harness's hardcoded rgba8unorm-srgb viewFormats stay compatible with the
// dawn-node webgpu module's actual UA preference (which is bgra8unorm). Browser
// path (test:browser project) does not run smoke-dawn.mjs; the real Channel 2
// BGRA path is exercised through the helper unmodified there.
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

// --- 3. Asset fixtures check ---

if (!existsSync(CONTAINER2_SRC_PATH)) {
  console.error(
    `[smoke] FAIL - asset fixture missing: ${CONTAINER2_SRC_PATH}`,
  );
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
  Camera,
  createRenderer,
  HANDLE_CUBE,
  MeshFilter,
  MeshRenderer,
  Transform,
} = enginePkg;
const { unwrapHandle } = await import('@forgeax/engine-types');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');

const container2DecodeRes = await decodeImageFromFile(CONTAINER2_SRC_PATH);
if (!container2DecodeRes.ok) {
  console.error(
    '[smoke] FAIL - decodeImageFromFile failed:',
    container2DecodeRes.error.code,
  );
  process.exit(1);
}
const { decoded: container2Decoded } = container2DecodeRes.value;
console.log(
  `[learn-render-5-1-blinn-phong] decoded container2=${container2Decoded.width}x${container2Decoded.height} ${container2Decoded.mime}`,
);

const { buildEngineShaderManifest } = await import(
  '@forgeax/engine-vite-plugin-shader'
);
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

console.log(`[learn-render-5-1-blinn-phong] backend=${renderer.backend}`);

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

// Register the custom Blinn-Phong shader.
const shader = renderer.shader;
if (shader === null) {
  console.error('[smoke] FAIL - renderer.shader is null');
  process.exit(1);
}

// Register the custom Blinn-Phong shader from the build-output COMPOSED WGSL.
// `ShaderRegistry.registerMaterialShader` requires post-naga_oil composed WGSL
// (see packages/shader/src/ShaderRegistry.ts: `source` = "composed WGSL source
// (post-naga_oil)"). The runtime deliberately does NOT bundle naga_oil, so the
// raw `src/blinn-phong.wgsl` (which opens with `#define_import_path` + `#import`)
// cannot be registered directly -- it must go through the build-time vite-plugin
// composition (exactly as the real app does via `import ... from './blinn-phong.wgsl'`).
// This smoke has no vite transform, so read the demo build's composed entry from
// dist/shaders/manifest.json (mirrors apps/hello/custom-shader/scripts/smoke-dawn.mjs).
const DEMO_MANIFEST_PATH = resolve(APP_ROOT, 'dist', 'shaders', 'manifest.json');
if (!existsSync(DEMO_MANIFEST_PATH)) {
  console.error(`[smoke] FAIL - dist/shaders/manifest.json missing at ${DEMO_MANIFEST_PATH}`);
  console.error(
    "  hint: rebuild via `pnpm --filter '@forgeax/app-learn-render-5-advanced-lighting-1-advanced-lighting' build`",
  );
  process.exit(1);
}
const demoManifest = JSON.parse(readFileSync(DEMO_MANIFEST_PATH, 'utf8'));
const blinnPhongEntry = (demoManifest.materialShaders ?? []).find(
  (m) => m && typeof m.identifier === 'string' && m.identifier.includes('5_1_blinn_phong'),
);
if (!blinnPhongEntry) {
  console.error('[smoke] FAIL - manifest.materialShaders[] missing 5_1_blinn_phong entry');
  process.exit(1);
}
shader.registerMaterialShader('learn-render::5-1-blinn-phong', {
  source: blinnPhongEntry.composedWgsl,
  paramSchema: JSON.parse(blinnPhongEntry.paramSchema),
});

// Register texture under its GUID.
const container2GuidRes = AssetGuid.parse('019e3969-1d46-7945-a75a-ef97d537531e');
if (!container2GuidRes.ok) {
  console.error('[smoke] FAIL - GUID parse failed');
  process.exit(1);
}

const container2TexAsset = {
  kind: 'texture',
  width: container2Decoded.width,
  height: container2Decoded.height,
  format: container2Decoded.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
  data: container2Decoded.bytes,
  colorSpace: container2Decoded.colorSpace,
  mipmap: container2Decoded.mipmap,
};

const world = new World();

// Catalogue the texture under its GUID, then mint a shared-ref column handle.
assets.catalog(container2GuidRes.value, container2TexAsset);
const container2Handle = world.allocSharedRef('TextureAsset', container2TexAsset);
console.log(`[learn-render-5-1-blinn-phong] registered container2 handle id=${container2Handle}`);

// Register material with the custom shader.
const matHandle = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      shader: 'learn-render::5-1-blinn-phong',
      tags: { LightMode: 'Forward' },
    },
  ],
  paramValues: {
    baseColorTexture: unwrapHandle(container2Handle),
  },
});

// Spawn cube: HANDLE_CUBE is 1x1x1, centered at origin.
world
  .spawn(
    {
      component: Transform,
      data: {
        posX: 0, posY: 0, posZ: 0,
        quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
        scaleX: 1, scaleY: 1, scaleZ: 1,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [matHandle] } },
  )
  .unwrap();

// Camera at (0, 0, 3), FOV=45 deg.
world.spawn(
  {
    component: Transform,
    data: {
      posX: 0, posY: 0, posZ: 3,
      quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
      scaleX: 1, scaleY: 1, scaleZ: 1,
    },
  },
  {
    component: Camera,
    data: { fov: Math.PI / 4, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 },
  },
);

// --- 5. Draw frames ---

const frameStart = Date.now();
let framesObserved = 0;
const TARGET_FRAMES = SMOKE_MIN_FRAMES;
for (let i = 0; i < TARGET_FRAMES; i++) {
  world.update();
  const r = renderer.draw(world);
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;
}
const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
const frameWall = Date.now() - frameStart;
console.log(
  `[smoke] frames observed=${framesObserved} (wall=${frameWall}ms, target=${TARGET_FRAMES})`,
);

// --- 6. Verdict (structural-only) ---

const wallTotalMs = Date.now() - frameStart;
console.log(`[smoke] wallTotalMs=${wallTotalMs}`);

const failures = [];
if (renderer.backend !== 'webgpu')
  failures.push(`(a) backend=${renderer.backend} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES)
  failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(c) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-5-advanced-lighting-1-advanced-lighting' smoke",
  );
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 3 criteria GREEN: backend=webgpu, frames=${framesObserved}, RhiError count=0, wallTotalMs=${wallTotalMs}`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);