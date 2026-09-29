import type { CBAsset, CBFile, CBFileFamily, CBViewItem } from './types';

/** File families whose on-disk bytes are meaningfully shown as text/source. */
const SOURCE_TEXT_FAMILIES: ReadonlySet<CBFileFamily> = new Set([
  'code',
  'config',
  'doc',
  'data',
  'pack',
  'meta',
  'scene',
]);

const SOURCE_VIEW_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json',
]);

export type CBFilePreviewMode = 'assets' | 'source';

/** True when the on-disk filename is human-readable source (pack/json/code). */
export function isSourceViewableFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pack.json') || lower.endsWith('.pack.ts')) return true;
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : lower;
  return SOURCE_VIEW_EXTENSIONS.has(ext);
}

/** A catalog-backed file can show both its extracted assets and raw source. */
export function fileSupportsDualPreview(
  file: Pick<CBFile, 'family' | 'assets' | 'name'>,
): boolean {
  if (file.assets.length === 0) return false;
  return SOURCE_TEXT_FAMILIES.has(file.family) || isSourceViewableFileName(file.name);
}

/** Resolve the on-disk file row that owns a catalog asset (standalone packs). */
export function resolveBackingFile(
  asset: Pick<CBAsset, 'packPath'>,
  diskFiles: readonly CBFile[],
): CBFile | undefined {
  return diskFiles.find((file) => file.path === asset.packPath);
}

/** File row used for dual preview, whether the selection is the file or a promoted asset. */
export function resolveDualPreviewFile(
  item: CBViewItem,
  diskFiles: readonly CBFile[],
): CBFile | undefined {
  if (item.type === 'file') return item;
  if (item.type === 'asset') return resolveBackingFile(item, diskFiles);
  return undefined;
}
