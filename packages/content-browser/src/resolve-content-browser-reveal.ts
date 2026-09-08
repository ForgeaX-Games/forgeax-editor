import type { ContentBrowserRevealTarget } from '@forgeax/interface/core/app-shell/types';
import { catalogPathToRoot, type CatalogAssetRoot } from './catalog-root';
import { dirOfPath, isResourceGroup } from './content-browser-format';
import type { CBAsset, CBFile } from './types';

export interface ResolvedContentBrowserReveal {
  readonly dir: string;
  readonly selector: string;
  readonly expandPackPath?: string;
  readonly folderSelection?: { readonly path: string; readonly kind: 'dir' | 'file' };
}

export interface ResolveContentBrowserRevealContext {
  readonly relByAssetGuid: ReadonlyMap<string, string>;
  readonly diskFiles: readonly CBFile[];
  readonly allAssets: readonly CBAsset[];
  readonly gameSlug: string;
  readonly catalogAssetRoots: readonly CatalogAssetRoot[];
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Disk file whose catalog members include `guid` (imported glb/fbx or pack.json). */
export function findOwningDiskFile(diskFiles: readonly CBFile[], guid: string): CBFile | undefined {
  return diskFiles.find(file => file.assets.some(asset => asset.guid === guid));
}

export function resolveContentBrowserReveal(
  target: ContentBrowserRevealTarget,
  ctx: ResolveContentBrowserRevealContext,
): ResolvedContentBrowserReveal | null {
  if (target.path) {
    const kind = target.pathKind ?? 'file';
    return {
      dir: dirOfPath(target.path),
      selector: kind === 'dir'
        ? `[data-folder-path="${cssEscape(target.path)}"]`
        : `[data-file-path="${cssEscape(target.path)}"]`,
      folderSelection: { path: target.path, kind },
    };
  }

  if (!target.guid) return null;

  const { guid } = target;
  const asset = ctx.allAssets.find(row => row.guid === guid);
  const owningFile = findOwningDiskFile(ctx.diskFiles, guid);

  let dir = '';
  let expandPackPath: string | undefined;

  if (owningFile) {
    dir = dirOfPath(owningFile.path);
    if (isResourceGroup(owningFile.assets.length)) expandPackPath = owningFile.path;
  } else {
    const rel = ctx.relByAssetGuid.get(guid)
      ?? (target.sourcePath
        ? catalogPathToRoot(target.sourcePath, ctx.gameSlug, ctx.catalogAssetRoots)
        : null)
      ?? (asset?.sourcePath
        ? catalogPathToRoot(asset.sourcePath, ctx.gameSlug, ctx.catalogAssetRoots)
        : null)
      ?? (target.packPath
        ? catalogPathToRoot(target.packPath, ctx.gameSlug, ctx.catalogAssetRoots)
        : null);
    if (!rel) return null;
    dir = dirOfPath(rel);
  }

  return {
    dir,
    selector: `[data-asset-guid="${cssEscape(guid)}"]`,
    ...(expandPackPath ? { expandPackPath } : {}),
  };
}
