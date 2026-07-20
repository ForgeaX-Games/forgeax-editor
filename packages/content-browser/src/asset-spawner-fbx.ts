/**
 * FBX / meta sub-asset → scene spawn. Use `requestAddAssetToScene` from panels;
 * this module exists for direct spawn call sites.
 */
import { spawnAssetRefToScene, type DragAssetRef } from '@forgeax/editor-core';
import type { AssetChatRef } from '@forgeax/editor-core';

export { spawnAssetRefToScene, spawnAssetRefToScene as spawnAssetToScene };

export function spawnFbxAssetToScene(ref: AssetChatRef | DragAssetRef): Promise<void> {
  return spawnAssetRefToScene(ref);
}
