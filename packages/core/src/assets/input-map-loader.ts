// assets/input-map-loader — teach AssetRegistry how to load editor-owned `input-map`.
//
// Same host-custom-kind seam as material-instance: identity projection + shape guard.

import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { readPack } from '../io/asset-io-primitives';
import { hasPathResolver, resolveGamePath } from '../util/path-resolver';
import {
  INPUT_MAP_KIND,
  isInputMapPayload,
  type InputMapPayload,
} from './input-map-schema';

export interface LoadedInputMapAsset {
  readonly name: string;
  readonly payload: InputMapPayload;
}

function resolvePackPathOnce(packPath: string): string {
  if (!hasPathResolver()) return packPath;
  const root = resolveGamePath('');
  if (root && (packPath === root || packPath.startsWith(`${root}/`))) return packPath;
  return resolveGamePath(packPath);
}

/** Reload the pack-owned payload instead of trusting persisted page metadata,
 * which is only an opening descriptor and can be stale after Ctrl/Cmd+S. */
export async function loadInputMapAsset(
  packPath: string,
  guid: string,
): Promise<LoadedInputMapAsset | null> {
  const pack = await readPack(resolvePackPathOnce(packPath));
  const asset = pack?.assets.find(
    (candidate) => candidate.guid.toLowerCase() === guid.toLowerCase(),
  );
  if (!asset || asset.kind !== INPUT_MAP_KIND || !isInputMapPayload(asset.payload)) return null;
  return {
    name: asset.name ?? guid,
    payload: asset.payload,
  };
}

export function inputMapLoader(): {
  readonly kind: string;
  load(payload: Record<string, unknown>): InputMapPayload | undefined;
} {
  return {
    kind: INPUT_MAP_KIND,
    load(payload: Record<string, unknown>): InputMapPayload | undefined {
      return isInputMapPayload(payload) ? payload : undefined;
    },
  };
}

export function registerInputMapLoader(registry: AssetRegistry | undefined): void {
  registry?.loaders?.register(inputMapLoader() as never);
}
