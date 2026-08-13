import { assetIO } from '@forgeax/editor-core';
import { createDevImportTransport } from '@forgeax/engine-runtime';
import { resolveViewportShaderManifestUrl } from './shader-manifest-url';

/**
 * Build the bundler inputs for an isolated preview world.
 *
 * A preview is a second engine App, not a second asset authority. In Studio
 * its authored shader packages live behind the active Play producer's scoped
 * manifest and import route; using the editor-root manifest makes custom VFX
 * materials compile to no drawable pipeline while the particle simulation
 * still reports healthy. Standalone keeps the local game manifest.
 */
export function createPreviewBundlerOptions() {
  const binding = assetIO.getRuntimeBinding();
  const base = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
  const gameDirAbs = typeof __FORGEAX_GAME_DIR_ABS__ === 'string'
    ? __FORGEAX_GAME_DIR_ABS__
    : null;
  return {
    shaderManifestUrl: resolveViewportShaderManifestUrl(
      base,
      binding !== undefined,
      gameDirAbs,
    ),
    ...(binding === undefined ? {} : { importTransport: createDevImportTransport(binding) }),
  };
}
