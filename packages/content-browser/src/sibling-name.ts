// sibling-name — UE-parity unique default names + same-location collision checks
// for Content Browser inline create/rename. Reads the already-loaded disk tree
// (no extra IO); DnD move uses the same directory scan pattern.

import { validateAssetBasename } from '@forgeax/editor-core';
import type { TFunction } from '@forgeax/editor-core/i18n';
import type { CBFile, CBViewItem } from './types';
import { dirOfPath } from './content-browser-format';

const PACK_JSON_SUFFIX = '.pack.json';

export function normalizeSceneSlug(id: string): string {
  return id.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** UE-style auto-increment: NewMaterial → NewMaterial1 → NewMaterial2 … */
export function generateUniqueName(prefix: string, taken: ReadonlySet<string>): string {
  if (!taken.has(prefix)) return prefix;
  for (let i = 1; ; i++) {
    const candidate = `${prefix}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function collectDirectorySiblingNames(
  parentPath: string,
  allDirs: readonly string[],
  diskFiles: readonly Pick<CBFile, 'path' | 'name'>[],
): Set<string> {
  const names = new Set<string>();
  for (const dir of allDirs) {
    if (dirOfPath(dir) === parentPath) names.add(dir.slice(dir.lastIndexOf('/') + 1));
  }
  for (const file of diskFiles) {
    if (dirOfPath(file.path) === parentPath) names.add(file.name);
  }
  return names;
}

export function collectPackAssetSiblingNames(
  packPath: string,
  diskFiles: readonly Pick<CBFile, 'path' | 'assets'>[],
): Set<string> {
  const file = diskFiles.find((row) => row.path === packPath);
  if (!file) return new Set();
  return new Set(file.assets.map((asset) => asset.name));
}

export function collectScriptablePackStems(
  parentPath: string,
  diskFiles: readonly Pick<CBFile, 'path' | 'name'>[],
): Set<string> {
  const stems = new Set<string>();
  for (const file of diskFiles) {
    if (dirOfPath(file.path) !== parentPath) continue;
    if (!file.name.endsWith('.pack.ts')) continue;
    stems.add(file.name.slice(0, -'.pack.ts'.length));
  }
  return stems;
}

export function collectStandalonePackStems(
  parentPath: string,
  diskFiles: readonly Pick<CBFile, 'path' | 'name'>[],
): Set<string> {
  const stems = new Set<string>();
  for (const file of diskFiles) {
    if (dirOfPath(file.path) !== parentPath) continue;
    if (!file.name.endsWith(PACK_JSON_SUFFIX)) continue;
    stems.add(file.name.slice(0, -PACK_JSON_SUFFIX.length));
  }
  return stems;
}

export function collectSceneSiblingSlugs(
  sceneIds: readonly string[],
  diskFiles: readonly Pick<CBFile, 'path' | 'name'>[],
): Set<string> {
  const taken = new Set(sceneIds);
  const scenesDir = 'assets/scenes';
  for (const file of diskFiles) {
    if (dirOfPath(file.path) !== scenesDir) continue;
    if (!file.name.endsWith(PACK_JSON_SUFFIX)) continue;
    taken.add(file.name.slice(0, -PACK_JSON_SUFFIX.length));
  }
  return taken;
}

export interface SiblingNameData {
  readonly allDirs: readonly string[];
  readonly diskFiles: readonly CBFile[];
  readonly sceneIds: readonly string[];
}

function duplicateHint(t: TFunction, name: string, item: CBViewItem): string {
  if (item.type === 'folder') {
    return t('editor.contentBrowser.dialogs.duplicateFolderAtLocation', { name });
  }
  if (item.type === 'file') {
    return t('editor.contentBrowser.dialogs.duplicateFileAtLocation', { name });
  }
  return t('editor.contentBrowser.dialogs.duplicateNameAtLocation', { name });
}

/** Validate a basename/display name for inline rename, excluding the item itself. */
export function validateSiblingNameForItem(
  rawValue: string,
  item: CBViewItem,
  data: SiblingNameData,
  t: TFunction,
): string | null {
  const value = rawValue.trim();
  const basename = validateAssetBasename(value);
  if (!basename.ok) return basename.hint;

  if (item.type === 'folder') {
    const parent = dirOfPath(item.path);
    const siblings = collectDirectorySiblingNames(parent, data.allDirs, data.diskFiles);
    if (siblings.has(value) && value !== item.name) {
      return duplicateHint(t, value, item);
    }
    return null;
  }

  if (item.type === 'file') {
    const parent = dirOfPath(item.path);
    const siblings = collectDirectorySiblingNames(parent, data.allDirs, data.diskFiles);
    if (siblings.has(value) && value !== item.name) {
      return duplicateHint(t, value, item);
    }
    return null;
  }

  const packSiblings = collectPackAssetSiblingNames(item.packPath, data.diskFiles);
  if (packSiblings.has(value) && value !== item.name) {
    return duplicateHint(t, value, item);
  }
  return null;
}

export type CreateNameScope =
  | { kind: 'directory'; parentPath: string }
  | { kind: 'pack-assets'; packPath: string }
  | { kind: 'standalone-pack'; parentPath: string }
  | { kind: 'scene' }
  | { kind: 'scriptable-pack'; parentPath: string };

export function createNameScopeForAssetKind(
  kind: string,
  packDir: string,
): CreateNameScope {
  if (kind === 'scene') return { kind: 'scene' };
  if (kind === 'scriptable-pack') return { kind: 'scriptable-pack', parentPath: packDir };
  if (kind === 'material' || kind === 'material-instance') {
    return { kind: 'pack-assets', packPath: `${packDir}/Materials.pack.json` };
  }
  if (kind === 'input-map' || kind === 'particle-effect') {
    return { kind: 'standalone-pack', parentPath: packDir };
  }
  return { kind: 'standalone-pack', parentPath: packDir };
}

export function collectTakenNamesForCreateScope(
  scope: CreateNameScope,
  data: SiblingNameData,
): Set<string> {
  switch (scope.kind) {
    case 'directory':
      return collectDirectorySiblingNames(scope.parentPath, data.allDirs, data.diskFiles);
    case 'pack-assets':
      return collectPackAssetSiblingNames(scope.packPath, data.diskFiles);
    case 'standalone-pack':
      return collectStandalonePackStems(scope.parentPath, data.diskFiles);
    case 'scriptable-pack':
      return collectScriptablePackStems(scope.parentPath, data.diskFiles);
    case 'scene':
      return collectSceneSiblingSlugs(data.sceneIds, data.diskFiles);
  }
}

export function generateDefaultCreateName(
  prefix: string,
  scope: CreateNameScope,
  data: SiblingNameData,
): string {
  const taken = collectTakenNamesForCreateScope(scope, data);
  return generateUniqueName(prefix, taken);
}

