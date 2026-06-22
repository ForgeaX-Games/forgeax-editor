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

interface RegistryLike { register?(desc: unknown): { unwrap(): unknown } }
interface StoreLike {
  // Engine 2026-06-14: uploadCubemapFromEquirect takes 3 args
  // (world, sourceHandle, sourcePod). The source equirect is minted as a shared
  // column handle via world.allocSharedRef('TextureAsset', pod).
  uploadCubemapFromEquirect(world: unknown, sourceHandle: unknown, sourcePod: unknown): Promise<{ ok: boolean; value?: unknown; error?: unknown }>;
}
interface SpawnResultLike { unwrap(): unknown }
interface WorldLike {
  spawn(...componentDatas: unknown[]): SpawnResultLike;
  /** Patch component fields on an existing entity (used to upgrade a
   *  solid-color Skylight to image-based lighting once the cubemap is ready). */
  set(entity: unknown, component: unknown, data: unknown): unknown;
  /** Engine removed AssetRegistry.register; shared assets are now minted via
   *  `world.allocSharedRef(brand, payload)` which returns a u32 column handle
   *  directly (no Result / no .unwrap()). */
  allocSharedRef(target: string, payload: unknown): unknown;
}
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
// 404 is the expected "this candidate doesn't exist, try the next one" signal
// in the multi-URL fallback chain — silent. Decode failures still warn.
async function loadHdrEquirect(url: string): Promise<Equirect | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    const res = decodeHdr(bytes) as { ok: boolean; value?: { width: number; height: number; data: Float32Array }; error?: unknown };
    if (!res.ok || !res.value) { console.warn(`[editor] decodeHdr failed for ${url}:`, res.error); return null; }
    const { width, height, data } = res.value;
    return { kind: 'texture', width, height, format: 'rgba32float', data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), colorSpace: 'linear', mipmap: false };
  } catch (e) {
    console.warn(`[editor] HDR fetch error for ${url}:`, (e as Error)?.message ?? e);
    return null;
  }
}

/**
 * Set up the editor's environment: try each candidate HDR URL in order (e.g.
 * the game's authored `assets/sky.hdr`, then the shared template fallback),
 * fall back to a synthetic gradient if none load, precompute the IBL cubemap,
 * and spawn a Skylight (+ a SkyboxBackground when a real HDR was used).
 * Chromium-only; never throws.
 *
 * `hdrUrl` accepts a single URL or an ordered list. `404` is silent — only
 * decode failures log a warning. The first successful decode wins.
 */
export async function setupEditorSkylight(
  world: WorldLike,
  _assets: RegistryLike,
  store: StoreLike,
  opts: { hdrUrl?: string | readonly string[]; intensity?: number } = {},
): Promise<void> {
  const intensity = opts.intensity ?? 0.2;
  // ALWAYS spawn a solid-color Skylight first. The forgeax PBR shader computes
  // ambient=0 without a Skylight, so a lone DirectionalLight leaves shaded faces
  // black. A cubemap-less Skylight binds the engine's 1×1 white irradiance cube
  // — ambient is live on the first frame with no async GPU work, and it renders
  // on WebKit/WKWebView (the desktop Studio app) whose WebGPU lacks the
  // rgba16float render-attachment the IBL precompute needs. Neutral studio fill.
  let skylight: unknown;
  try {
    skylight = world.spawn(
      { component: Skylight, data: { colorR: 0.85, colorG: 0.9, colorB: 1.0, intensity: 0.35 } },
    ).unwrap();
  } catch (e) {
    console.warn('[editor] solid skylight spawn failed:', (e as Error)?.message ?? e);
    return;
  }
  try {
    // Skip the IBL precompute on WebKit/WKWebView — its WebGPU lacks the
    // rgba16float render-attachment the engine's equirect→cubemap pass needs
    // (and calling it there poisons the device). The solid ambient above
    // remains. Detect by UA: Safari/WKWebView contains "Safari" but NOT any
    // Chromium marker. Allowlisting the negative side directly is more robust
    // than `\bChrome\b` whose word boundary misses Playwright's "HeadlessChrome".
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const isChromium = /Chrome|Chromium|Edg/.test(ua);
    if (!isChromium) {
      console.info('[editor] non-Chromium WebGPU (WebKit/WKWebView): solid-color skylight only (no IBL/skybox)');
      return;
    }
    if (typeof store?.uploadCubemapFromEquirect !== 'function') {
      console.warn('[editor] no store.uploadCubemapFromEquirect — solid-color skylight only');
      return;
    }
    const candidates: readonly string[] = opts.hdrUrl === undefined
      ? []
      : (typeof opts.hdrUrl === 'string' ? [opts.hdrUrl] : opts.hdrUrl);
    let hdr: Equirect | null = null;
    for (const url of candidates) {
      hdr = await loadHdrEquirect(url);
      if (hdr) break;
    }
    const equirect = hdr ?? buildEnvironmentEquirect();
    // Mint the equirect source as a shared column handle, then precompute the
    // IBL cubemap (engine 3-arg upload: world, sourceHandle, sourcePod).
    const sourceHandle = world.allocSharedRef('TextureAsset', equirect);
    const res = await store.uploadCubemapFromEquirect(world, sourceHandle, equirect);
    if (!res.ok || res.value === undefined) { console.warn('[editor] cubemap precompute failed:', res.error); return; }
    const cubemap = res.value;
    // Upgrade the existing Skylight to image-based lighting (neutral tint lets
    // the cubemap drive the color).
    world.set(skylight, Skylight, { cubemap, colorR: 1, colorG: 1, colorB: 1, intensity });
    // Visible sky only for a real HDR — the synthetic gradient is for ambient
    // fill, not a backdrop (and the skybox needs the camera's tonemap active).
    if (hdr) world.spawn({ component: SkyboxBackground, data: { cubemap, mode: SKYBOX_MODE_CUBEMAP } });
    // Success messages — informational, not warnings (Chrome devtools renders
    // console.warn yellow; saving the warn channel for actually-skipped paths).
    console.info(hdr ? '[editor] HDR skylight + skybox active' : '[editor] synthetic skylight active (no HDR)');
  } catch (e) {
    console.warn('[editor] setupEditorSkylight failed:', (e as Error)?.message ?? e);
  }
}
