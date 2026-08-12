/**
 * Resolve the shader manifest for the viewport's carrier.
 *
 * Standalone/Edit Runtime owns the selected game's shader plugin and serves the
 * manifest beside `/editor/`. Studio's late-bound Runtime delegates authored
 * shader packages to the Play producer behind `/preview/`.
 */
export function resolveViewportShaderManifestUrl(
  baseUrl: string,
  hasRuntimeBinding: boolean,
  gameDirAbs: string | null | undefined,
): string {
  const base = baseUrl.replace(/\/$/, '');
  const selfHosted = typeof gameDirAbs === 'string' && gameDirAbs.length > 0;
  return hasRuntimeBinding && !selfHosted
    ? `${base}/preview/shaders/manifest.json`
    : `${base}/shaders/manifest.json`;
}
