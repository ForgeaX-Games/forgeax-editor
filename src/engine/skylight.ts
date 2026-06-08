// Editor environment lighting + skybox via the engine's IBL cubemap path.
//
// The forgeax PBR shader computes `ambient = 0` without a Skylight, so a lone
// DirectionalLight leaves shaded faces black. A Skylight (image-based lighting)
// supplies the missing ambient/specular fill; a SkyboxBackground draws the same
// cubemap as the visible sky.
//
// Source priority: the game's authored HDR (`assets/sky.hdr`) when present —
// decoded to an rgba32float equirect, uploaded through the engine's
// equirect→cubemap IBL precompute, and bound to BOTH Skylight (lighting) and
// SkyboxBackground (visible sky). If no HDR (or decode fails), a synthesised
// neutral-studio gradient drives the Skylight alone (ambient fill, no visible
// skybox). The whole path is Chromium-only: WebKit/WKWebView's WebGPU lacks the
// rgba16float render-attachment the IBL precompute needs (see the gap report to
// ubpa) — there it is skipped and the scene renders with the directional sun.
import { Skylight, SkyboxBackground, SKYBOX_MODE_CUBEMAP } from '@forgeax/engine-runtime';
import { decodeHdr } from '@forgeax/engine-image/hdr-decoder';

interface RegistryLike { register(desc: unknown): { unwrap(): unknown } }
interface StoreLike {
  uploadCubemapFromEquirect(handle: unknown, pod: unknown): Promise<{ ok: boolean; value?: unknown; error?: unknown }>;
}
interface WorldLike { spawn(...componentDatas: unknown[]): unknown }
interface Equirect { kind: 'texture'; width: number; height: number; format: string; data: Uint8Array; colorSpace: string; mipmap: boolean }

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// Synthetic neutral-studio equirect (fallback when there's no authored HDR):
// light sky above → bright horizon → darker warm ground. HDR float (rgba32float).
function buildEnvironmentEquirect(w = 128, h = 64): Equirect {
  const f = new Float32Array(w * h * 4);
  const sky: [number, number, number] = [0.70, 0.80, 1.05];
  const horizon: [number, number, number] = [0.85, 0.85, 0.85];
  const ground: [number, number, number] = [0.28, 0.26, 0.23];
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1);
    let r: number; let g: number; let b: number;
    if (t < 0.5) { const k = t / 0.5; r = lerp(sky[0], horizon[0], k); g = lerp(sky[1], horizon[1], k); b = lerp(sky[2], horizon[2], k); }
    else { const k = (t - 0.5) / 0.5; r = lerp(horizon[0], ground[0], k); g = lerp(horizon[1], ground[1], k); b = lerp(horizon[2], ground[2], k); }
    for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; f[i] = r; f[i + 1] = g; f[i + 2] = b; f[i + 3] = 1; }
  }
  return { kind: 'texture', width: w, height: h, format: 'rgba32float', data: new Uint8Array(f.buffer), colorSpace: 'linear', mipmap: false };
}

// Fetch + decode an .hdr (Radiance RGBE) into an rgba32float equirect, or null.
async function loadHdrEquirect(url: string): Promise<Equirect | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    const res = decodeHdr(bytes) as { ok: boolean; value?: { width: number; height: number; data: Float32Array }; error?: unknown };
    if (!res.ok || !res.value) { console.warn('[editor] decodeHdr failed:', res.error); return null; }
    const { width, height, data } = res.value;
    return { kind: 'texture', width, height, format: 'rgba32float', data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), colorSpace: 'linear', mipmap: false };
  } catch (e) {
    console.warn('[editor] HDR fetch/decode error:', (e as Error)?.message ?? e);
    return null;
  }
}

/**
 * Set up the editor's environment: load the game's HDR (or fall back to a
 * synthetic gradient), precompute its IBL cubemap, and spawn a Skylight (+ a
 * SkyboxBackground when a real HDR is used). Chromium-only; never throws.
 */
export async function setupEditorSkylight(
  world: WorldLike,
  assets: RegistryLike,
  store: StoreLike,
  opts: { hdrUrl?: string; intensity?: number } = {},
): Promise<void> {
  const intensity = opts.intensity ?? 0.2;
  try {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    if (!/\b(Chrome|Chromium|Edg)\b/.test(ua)) {
      console.warn('[editor] non-Chromium WebGPU (WebKit/WKWebView): skipping IBL skylight/skybox; directional light only');
      return;
    }
    if (typeof store?.uploadCubemapFromEquirect !== 'function') {
      console.warn('[editor] no store.uploadCubemapFromEquirect — skipping skylight');
      return;
    }
    const hdr = opts.hdrUrl ? await loadHdrEquirect(opts.hdrUrl) : null;
    const equirect = hdr ?? buildEnvironmentEquirect();
    const handle = assets.register(equirect).unwrap();
    const res = await store.uploadCubemapFromEquirect(handle, equirect);
    if (!res.ok || res.value === undefined) { console.warn('[editor] cubemap precompute failed:', res.error); return; }
    const cubemap = res.value;
    world.spawn({ component: Skylight, data: { cubemap, intensity } });
    // Visible sky only for a real HDR — the synthetic gradient is for ambient
    // fill, not a backdrop (and the skybox needs the camera's tonemap active).
    if (hdr) world.spawn({ component: SkyboxBackground, data: { cubemap, mode: SKYBOX_MODE_CUBEMAP } });
    console.warn(hdr ? '[editor] HDR skylight + skybox active' : '[editor] synthetic skylight active (no HDR)');
  } catch (e) {
    console.warn('[editor] setupEditorSkylight failed:', (e as Error)?.message ?? e);
  }
}
