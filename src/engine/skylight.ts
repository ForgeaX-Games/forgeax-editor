// Editor ambient lighting via IBL Skylight.
//
// The forgeax PBR shader computes `ambient = 0` unless a Skylight (image-based
// lighting) is present — a single DirectionalLight then leaves every shaded
// face pure black, which reads as "broken geometry" on a dense imported scene.
// A reference glTF viewer looks clean because it adds a hemisphere fill light;
// the engine's equivalent is a Skylight fed by an environment cubemap.
//
// Rather than ship an HDR file, we synthesise a neutral studio environment
// (light sky above → mid horizon → darker ground below) as a small equirect
// texture, upload it through the engine's equirect→cubemap path (which runs the
// 4-pass IBL precompute), and spawn one Skylight. The result is soft, even
// ambient fill — the missing half of the lighting.
import { Skylight } from '@forgeax/engine-runtime';

interface RegistryLike { register(desc: unknown): { unwrap(): unknown } }
interface StoreLike {
  uploadCubemapFromEquirect(
    handle: unknown,
    pod: unknown,
  ): Promise<{ ok: boolean; value?: unknown; error?: unknown }>;
}
interface WorldLike { spawn(...componentDatas: unknown[]): unknown }

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// Build a neutral environment equirect: zenith (top row) sky-ish light blue-grey,
// fading through a bright horizon to a darker, warmer ground at the nadir. The
// IBL precompute requires an HDR float source (rgba32float, linear), so radiance
// is written as Float32 (values may exceed 1 for a punchier sky).
function buildEnvironmentEquirect(w = 128, h = 64): {
  kind: 'texture'; width: number; height: number; format: string;
  data: Uint8Array; colorSpace: string; mipmap: boolean;
} {
  const f = new Float32Array(w * h * 4);
  // linear-space radiance triples (HDR — sky a touch above 1 reads as daylight)
  const sky: [number, number, number] = [0.70, 0.80, 1.05];
  const horizon: [number, number, number] = [0.85, 0.85, 0.85];
  const ground: [number, number, number] = [0.28, 0.26, 0.23];
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1); // 0 = zenith (up), 1 = nadir (down)
    let r: number; let g: number; let b: number;
    if (t < 0.5) {
      const k = t / 0.5;
      r = lerp(sky[0], horizon[0], k); g = lerp(sky[1], horizon[1], k); b = lerp(sky[2], horizon[2], k);
    } else {
      const k = (t - 0.5) / 0.5;
      r = lerp(horizon[0], ground[0], k); g = lerp(horizon[1], ground[1], k); b = lerp(horizon[2], ground[2], k);
    }
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      f[i] = r; f[i + 1] = g; f[i + 2] = b; f[i + 3] = 1;
    }
  }
  return { kind: 'texture', width: w, height: h, format: 'rgba32float', data: new Uint8Array(f.buffer), colorSpace: 'linear', mipmap: false };
}

/**
 * Register a synthetic environment, precompute its IBL cubemap, and spawn one
 * Skylight into `world` so PBR surfaces gain ambient fill. Idempotent enough for
 * one call at editor boot; failures are logged, never thrown (the scene still
 * renders with just the directional sun).
 */
export async function setupEditorSkylight(
  world: WorldLike,
  assets: RegistryLike,
  store: StoreLike,
  intensity = 1.15,
): Promise<void> {
  try {
    // WebKit / WKWebView (Tauri desktop app) has a much weaker WebGPU than
    // Chromium's Dawn — notably the rgba16/32float + compute-shader IBL
    // precompute path. Attempting it there produces a cubemap the main pass
    // can't sample, throwing in recordFrame EVERY frame → the whole viewport
    // goes black (fps stays 60 because the draw fast-fails). So only run IBL on
    // Chromium, where it's verified; elsewhere the scene renders with the
    // directional sun alone (still fully visible, just no ambient fill).
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const isChromium = /\b(Chrome|Chromium|Edg)\b/.test(ua);
    if (!isChromium) {
      console.warn('[editor] non-Chromium WebGPU (WebKit/WKWebView): skipping IBL skylight; using directional light only');
      return;
    }
    if (typeof store?.uploadCubemapFromEquirect !== 'function') {
      console.warn('[editor] no store.uploadCubemapFromEquirect — skipping ambient skylight');
      return;
    }
    const equirect = buildEnvironmentEquirect();
    const handle = assets.register(equirect).unwrap();
    const res = await store.uploadCubemapFromEquirect(handle, equirect);
    if (!res.ok || res.value === undefined) {
      console.warn('[editor] skylight cubemap precompute failed:', res.error);
      return;
    }
    world.spawn({ component: Skylight, data: { cubemap: res.value, intensity } });
  } catch (e) {
    console.warn('[editor] setupEditorSkylight failed:', (e as Error)?.message ?? e);
  }
}
