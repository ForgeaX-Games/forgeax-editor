// @forgeax/engine-runtime - Skylight (image-based lighting environment map).
//
// Schema: 2 fields -- cubemap (Handle<CubeTextureAsset>, u32-stored handle)
// + intensity (f32, default 1.0). Naming convention follows the
// DirectionalLight / PointLight / SpotLight family: no Component suffix
// (AGENTS.md rule #1).
//
// Plan-strategy D-6: Skylight component schema is registered but no
// independent ECS system is created. All Skylight processing happens inside
// RenderSystem's extract/record phases.
//
// AI user minimum spawn (AC-13, charter P4):
//   world.spawn({ component: Skylight, data: { cubemap, intensity: 1.0 } });
//
// Single component activates the full IBL pipeline transparently.
//
// Edge cases handled by t27 / t26:
//   - Multi-Skylight: first archetype hit wins, console.warn in dev+prod
//   - intensity=0: ambient term = 0, mathematically valid, no warn
//   - Missing cubemap handle: structured error via RhiError path

import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Skylight environment map (image-based lighting source).
 *
 * A single Skylight entity activates diffuse + specular IBL for all
 * StandardMaterial surfaces in the scene. The engine handles the full
 * precompute pipeline (equirectangular->cubemap conversion, diffuse
 * irradiance convolution, specular prefilter mip chain, BRDF LUT)
 * transparently on startup.
 *
 * `cubemap` is a `Handle<CubeTextureAsset>` produced by
 * `engine.store.uploadCubemapFromEquirect(equirectHandle, equirectPod)`. The
 * handle is idempotent: same source handle returns the same cube handle.
 *
 * `intensity` is a linear multiplier on the ambient contribution.
 * Default = 1.0; 0 disables IBL (ambient term = 0).
 *
 * @example Minimum spawn (default intensity 1.0):
 *   // 1. resolve GUID from vite pack-index (see forgeax-engine-vite-plugin-pack)
 *   import { AssetGuid } from '@forgeax/engine-pack';
 *   const guidRes = AssetGuid.parse('019e4a26-3c29-7420-af5d-20f2724a16b0');
 *   if (!guidRes.ok) throw guidRes.error;
 *   // 2. load HDR equirect via the GUID-addressed pack route
 *   const hdrRes = await engine.assets.loadByGuid<TextureAsset>(guidRes.value);
 *   if (!hdrRes.ok) throw hdrRes.error;
 *   // 3. precompute the IBL cubemap chain (idempotent on same equirect handle)
 *   const hdrPod = engine.assets.get<TextureAsset>(hdrRes.value);
 *   if (!hdrPod.ok) throw hdrPod.error;
 *   const cubeRes = await engine.store.uploadCubemapFromEquirect(hdrRes.value, hdrPod.value);
 *   if (!cubeRes.ok) throw cubeRes.error;
 *   // 4. spawn the Skylight component — single field activates full IBL path
 *   world.spawn({ component: Skylight, data: { cubemap: cubeRes.value } });
 *
 * @example Dimmed ambient (intensity 0.5):
 *   world.spawn({ component: Skylight, data: { cubemap: cubeRes.value, intensity: 0.5 } });
 */
export const Skylight = defineComponent('Skylight', {
  cubemap: { type: 'handle<CubeTextureAsset>' },
  intensity: { type: 'f32', default: 1.0 },
});
