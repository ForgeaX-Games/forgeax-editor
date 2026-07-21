import type { CBAsset, CBFile, CBFileFamily, CBFolder } from './types';
import { isHiddenDir } from './view-mode';

/**
 * A catalog asset paired with its game-relative `.pack.json` path.
 *
 * `rel` is the engine registry `relativeUrl` reduced to game scope
 * (e.g. `assets/characters/hero.pack.json`). This is the SAME value the
 * ContentBrowser already computes for its source-panel folder list — folders
 * are DERIVED from it, so no new persisted data format is introduced.
 */
export interface ScopedAsset {
  asset: CBAsset;
  rel: string;
}

export interface ContentView {
  /** Immediate subfolders of `currentPath`, sorted by name. */
  folders: CBFolder[];
  /** Assets that sit DIRECTLY in `currentPath` (non-recursive, UE-parity). */
  assets: CBAsset[];
}

/** Directory portion of a rel path (`a/b/c.json` → `a/b`; `c.json` → ``). */
function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

/**
 * Compute the UE-style Content Browser view for a folder: its immediate
 * subfolders (as `CBFolder` view-models) plus the assets sitting directly in
 * it. Unlike a recursive flatten, descendant assets stay hidden until the user
 * drills into the subfolder — matching UE5's default (non-recursive) folder
 * contents.
 */
export function deriveContentView(params: {
  scopedAssets: ScopedAsset[];
  packDirs: string[];
  currentPath: string;
  favorites?: string[];
}): ContentView {
  const { scopedAssets, packDirs, currentPath, favorites = [] } = params;

  const prefix = currentPath ? `${currentPath}/` : '';
  const depth = currentPath ? currentPath.split('/').length : 0;

  const favoriteSet = new Set(favorites);

  const folders: CBFolder[] = packDirs
    .filter((d) => d !== currentPath && d.startsWith(prefix) && d.split('/').length === depth + 1)
    .map((path) => ({
      type: 'folder' as const,
      path,
      name: path.split('/').pop() ?? path,
      isFavorite: favoriteSet.has(path),
      childCount: scopedAssets.reduce(
        (n, s) => (s.rel === path || s.rel.startsWith(`${path}/`) ? n + 1 : n),
        0,
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const assets: CBAsset[] = scopedAssets
    .filter((s) => dirOf(s.rel) === currentPath)
    .map((s) => s.asset);

  return { folders, assets };
}

// ── Project file-browser view ───────────────────────────────────────────────

/** Mirror of the `/api/files/tree` response node shape. */
export interface ProjectTreeNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size?: number;
  modifiedAt?: number;
  children?: ProjectTreeNode[];
}

export interface FileView {
  folders: CBFolder[];
  files: CBFile[];
}

/**
 * Find the tree node that corresponds to `targetPath` (game-relative, e.g.
 * `src/systems`). An empty targetPath means the project root (the tree root
 * itself).
 */
function findNodeAtPath(
  rootChildren: ProjectTreeNode[],
  targetPath: string,
): ProjectTreeNode[] | null {
  if (!targetPath) return rootChildren;
  const segments = targetPath.split('/');
  let nodes = rootChildren;
  for (const seg of segments) {
    const found = nodes.find(n => n.name === seg && n.type === 'dir');
    if (!found?.children) return null;
    nodes = found.children;
  }
  return nodes;
}

/**
 * Derive the file-browser view for a non-asset path: immediate subfolders
 * and files from the project directory tree. Hidden directories are excluded.
 */
export function deriveFileView(params: {
  projectTree: ProjectTreeNode[];
  currentPath: string;
  assetRootNames: string[];
}): FileView {
  const { projectTree, currentPath, assetRootNames } = params;
  const children = findNodeAtPath(projectTree, currentPath);
  if (!children) return { folders: [], files: [] };

  const assetRootSet = new Set(assetRootNames);

  const folders: CBFolder[] = children
    .filter(n => n.type === 'dir' && !isHiddenDir(n.name))
    .map(n => {
      const folderPath = currentPath ? `${currentPath}/${n.name}` : n.name;
      return {
        type: 'folder' as const,
        path: folderPath,
        name: n.name,
        isFavorite: false,
        childCount: countDescendantFiles(n),
        color: assetRootSet.has(folderPath) ? 'asset-root' : undefined,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const files: CBFile[] = children
    .filter(n => n.type === 'file')
    .map(n => {
      const filePath = currentPath ? `${currentPath}/${n.name}` : n.name;
      const family = fileFamilyOf(n.name);
      return {
        type: 'file' as const,
        name: n.name,
        path: filePath,
        diskPath: n.path || filePath,
        family,
        assets: [],
        kindLabel: fileKindLabel(family),
        isFavorite: false,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { folders, files };
}

function extensionOf(name: string): string {
  const dotIdx = name.lastIndexOf('.');
  return dotIdx > 0 ? name.slice(dotIdx).toLowerCase() : '';
}

function fileFamilyOf(name: string): CBFileFamily {
  if (name.toLowerCase().endsWith('.pack.json')) return 'pack';
  const ext = extensionOf(name);
  if (['.ts', '.tsx', '.js', '.jsx', '.jsonc', '.css', '.scss', '.wgsl', '.glsl', '.rs', '.py'].includes(ext)) return 'code';
  if (['.json', '.toml', '.yaml', '.yml'].includes(ext)) return 'config';
  if (['.md', '.txt'].includes(ext)) return 'doc';
  if (['.scene', '.level'].includes(ext)) return 'scene';
  if (['.meta', '.import'].includes(ext)) return 'meta';
  if (['.png', '.jpg', '.jpeg', '.webp', '.hdr', '.ktx2'].includes(ext)) return 'image';
  if (['.mp3', '.wav', '.ogg'].includes(ext)) return 'audio';
  if (['.glb', '.gltf', '.fbx', '.obj'].includes(ext)) return 'model';
  if (['.ttf', '.otf', '.woff', '.woff2'].includes(ext)) return 'font';
  if (['.csv', '.xml', '.bin'].includes(ext)) return 'data';
  return 'other';
}

function fileKindLabel(family: CBFileFamily): string {
  switch (family) {
    case 'code': return 'Code';
    case 'config': return 'Config';
    case 'doc': return 'Document';
    case 'scene': return 'Scene';
    case 'pack': return 'Asset Pack';
    case 'meta': return 'Metadata';
    case 'image': return 'Image';
    case 'audio': return 'Audio';
    case 'model': return 'Model';
    case 'font': return 'Font';
    case 'data': return 'Data';
    default: return 'File';
  }
}

function countDescendantFiles(node: ProjectTreeNode): number {
  if (!node.children) return 0;
  let count = 0;
  for (const child of node.children) {
    if (child.type === 'file') count++;
    else count += countDescendantFiles(child);
  }
  return count;
}

/** Collect all directory paths from a project tree (excluding hidden dirs). */
export function collectProjectDirs(
  nodes: ProjectTreeNode[],
  parentPath = '',
): string[] {
  const dirs: string[] = [];
  for (const node of nodes) {
    if (node.type !== 'dir' || isHiddenDir(node.name)) continue;
    const path = parentPath ? `${parentPath}/${node.name}` : node.name;
    dirs.push(path);
    if (node.children) {
      dirs.push(...collectProjectDirs(node.children, path));
    }
  }
  return dirs;
}
