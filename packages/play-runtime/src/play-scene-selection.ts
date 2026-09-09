/** Resolve the SceneAsset a Play carrier must load.
 *
 * The editor launcher owns scene selection and passes it through `sceneGuid`.
 * `forge.json#defaultScene` remains the fallback for direct preview URLs.
 */
export function resolvePlaySceneGuid(
  requestedSceneGuid: string | null,
  projectDefaultScene: unknown,
): string | undefined {
  const requested = requestedSceneGuid?.trim();
  if (requested) return requested;
  return typeof projectDefaultScene === 'string' && projectDefaultScene.trim().length > 0
    ? projectDefaultScene.trim()
    : undefined;
}
