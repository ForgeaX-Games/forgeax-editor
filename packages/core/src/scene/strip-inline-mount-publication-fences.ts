/**
 * Remove catalog-derived publication fences from inline scene-pack mounts before
 * beacon/unload writes. Fences belong to the post-load catalog projection (P1),
 * not to durable pack bytes written without a fresh catalog reconcile.
 */

import type { SceneAsset } from '@forgeax/engine-types';

type PackAssetWire = {
  readonly guid: string;
  readonly kind: string;
  readonly refs?: readonly string[];
  readonly payload?: { readonly mounts?: Array<Record<string, unknown>> };
};

function resolveMountSourceGuid(
  mount: Record<string, unknown>,
  refs: readonly string[],
): string | undefined {
  const source = mount.source;
  if (typeof source === 'string') return source.toLowerCase();
  if (typeof source === 'number' && Number.isInteger(source) && source >= 0 && source < refs.length) {
    return refs[source]?.toLowerCase();
  }
  return undefined;
}

/** Strip publicationFence from every mount on a SceneAsset (pre-catalog / pre-instantiate). */
export function stripSceneAssetMountPublicationFences(scene: SceneAsset): SceneAsset {
  if (scene.mounts === undefined || scene.mounts.length === 0) return scene;
  const mounts = scene.mounts.map((mount) => {
    if (mount.publicationFence === undefined) return mount;
    const { publicationFence: _drop, ...rest } = mount;
    return rest;
  });
  return { ...scene, mounts };
}

/** Strip publicationFence from mounts whose source is another asset in the same pack. */
export function stripInlinePackMountPublicationFences(packObj: Record<string, unknown>): void {
  const assets = (packObj.assets as PackAssetWire[] | undefined) ?? [];
  if (assets.length === 0) return;
  const inlineGuids = new Set(assets.map((asset) => asset.guid.toLowerCase()));
  for (const asset of assets) {
    if (asset.kind !== 'scene') continue;
    const mounts = asset.payload?.mounts;
    if (mounts === undefined || mounts.length === 0) continue;
    const refs = asset.refs ?? [];
    for (const mount of mounts) {
      const sourceGuid = resolveMountSourceGuid(mount, refs);
      if (sourceGuid === undefined || !inlineGuids.has(sourceGuid)) continue;
      delete mount.publicationFence;
    }
  }
}
