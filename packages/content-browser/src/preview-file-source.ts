import type { CBFile, CBFileFamily } from './types';

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

export type CBFilePreviewMode = 'assets' | 'source';

/** A catalog-backed file can show both its extracted assets and raw source. */
export function fileSupportsDualPreview(file: Pick<CBFile, 'family' | 'assets'>): boolean {
  return file.assets.length > 0 && SOURCE_TEXT_FAMILIES.has(file.family);
}
