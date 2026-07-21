// content-browser-format — pure formatting/derivation helpers extracted from
// ContentBrowser.tsx so the component file focuses on state + wiring.
// Zero React state, zero side-effects. Any test that pins these helpers can
// import them directly here.

import type { TFunction } from '@forgeax/editor-core/i18n';
import { resolveGamePath } from '@forgeax/editor-core';
import type { CBAsset, CBFileFamily, CBViewItem } from './types';

// ── Internal types shared between ContentBrowser + its child components ─────

export interface SourceTreeNode {
  type: 'folder' | 'file';
  path: string;
  diskPath: string;
  name: string;
  childCount: number;
  isFavorite: boolean;
  family?: CBFileFamily;
  assets?: CBAsset[];
  children: SourceTreeNode[];
}

export interface DiskTreeNode {
  type: 'dir' | 'file';
  name: string;
  path: string;
  children?: DiskTreeNode[];
}

export interface PreviewFileInfo {
  path: string;
  kind: string;
  mime: string;
  size: number;
  mtime: number;
  content?: string;
}

/** Registry catalog entry as surfaced by the engine AssetRegistry.listCatalog(). */
export interface RegistryCatalogEntry {
  guid: string;
  kind: string;
  name?: string;
  relativeUrl: string;
  refs?: readonly string[];
  sourcePath?: string;
}

export type CBContextMenuEntry = {
  title?: string;
  sep?: true;
  label?: string;
  icon?: string;
  shortcut?: string;
  forge?: boolean;
  danger?: boolean;
  onClick?: () => void;
  disabled?: boolean;
};

// ── Path helpers ─────────────────────────────────────────────────────────────

export function dirOfPath(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function normalizeGameRelativePath(path: string, gameRootPath: string, gameSlug: string): string {
  const p = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const root = gameRootPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/$/, '');
  if (p === root) return '';
  if (root && p.startsWith(`${root}/`)) return p.slice(root.length + 1);
  const marker = ['.forgeax', 'games', gameSlug, ''].join('/');
  const markerIndex = p.indexOf(marker);
  if (markerIndex >= 0) return p.slice(markerIndex + marker.length);
  if (p === gameSlug) return '';
  if (p.startsWith(`${gameSlug}/`)) return p.slice(gameSlug.length + 1);
  return p;
}

export function viewItemPath(item: CBViewItem | null): string | null {
  if (!item) return null;
  if (item.type === 'asset') return item.packPath;
  return item.path;
}

export function viewItemKey(item: CBViewItem): string {
  if (item.type === 'asset') return item.guid;
  return item.path;
}

export function copyText(text: string): void {
  void navigator.clipboard.writeText(text);
}

export function isAbsoluteHostPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\');
}

export function resolveCopyPath(path: string): string {
  return isAbsoluteHostPath(path) ? path : resolveGamePath(path);
}

// ── File-family classification + label ──────────────────────────────────────

export function fileFamilyOf(name: string): CBFileFamily {
  const lower = name.toLowerCase();
  if (lower.endsWith('.meta.json')) return 'meta';
  if (lower.endsWith('.pack.json')) return lower.includes('scene') ? 'scene' : 'pack';
  if (lower.endsWith('.scene.json') || lower === 'scene.json') return 'scene';
  if (lower.endsWith('.colliders.json')) return 'data';
  const ext = lower.split('.').pop() ?? '';
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py'].includes(ext)) return 'code';
  if (['json', 'lock'].includes(ext)) return 'config';
  if (['md', 'markdown', 'txt'].includes(ext)) return 'doc';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico', 'hdr'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'opus'].includes(ext)) return 'audio';
  if (['glb', 'gltf', 'fbx'].includes(ext)) return 'model';
  if (['ttf', 'otf', 'woff2'].includes(ext)) return 'font';
  return 'other';
}

const FILE_KIND_FALLBACK_LABELS: Record<CBFileFamily, string> = {
  code: 'Code',
  config: 'Config',
  doc: 'Document',
  scene: 'Scene',
  pack: 'Asset Pack',
  meta: 'Metadata',
  image: 'Image',
  audio: 'Audio',
  model: '3D Model',
  font: 'Font',
  data: 'Data',
  other: 'File',
};

export function fileKindLabel(tOrFamily: TFunction | CBFileFamily | undefined, familyArg?: CBFileFamily): string {
  const family = familyArg ?? (typeof tOrFamily === 'string' ? tOrFamily : 'other');
  const translate = (key: string, fallback: string) => (
    typeof tOrFamily === 'function' ? tOrFamily(key) : fallback
  );
  switch (family) {
    case 'code': return translate('editor.contentBrowser.fileKinds.code', FILE_KIND_FALLBACK_LABELS.code);
    case 'config': return translate('editor.contentBrowser.fileKinds.config', FILE_KIND_FALLBACK_LABELS.config);
    case 'doc': return translate('editor.contentBrowser.fileKinds.doc', FILE_KIND_FALLBACK_LABELS.doc);
    case 'scene': return translate('editor.contentBrowser.fileKinds.scene', FILE_KIND_FALLBACK_LABELS.scene);
    case 'pack': return translate('editor.contentBrowser.fileKinds.pack', FILE_KIND_FALLBACK_LABELS.pack);
    case 'meta': return translate('editor.contentBrowser.fileKinds.meta', FILE_KIND_FALLBACK_LABELS.meta);
    case 'image': return translate('editor.contentBrowser.fileKinds.image', FILE_KIND_FALLBACK_LABELS.image);
    case 'audio': return translate('editor.contentBrowser.fileKinds.audio', FILE_KIND_FALLBACK_LABELS.audio);
    case 'model': return translate('editor.contentBrowser.fileKinds.model', FILE_KIND_FALLBACK_LABELS.model);
    case 'font': return translate('editor.contentBrowser.fileKinds.font', FILE_KIND_FALLBACK_LABELS.font);
    case 'data': return translate('editor.contentBrowser.fileKinds.data', FILE_KIND_FALLBACK_LABELS.data);
    default: return translate('editor.contentBrowser.fileKinds.other', FILE_KIND_FALLBACK_LABELS.other);
  }
}

// ── Context-menu shaping helpers ────────────────────────────────────────────

export function orderContextMenuEntries(entries: CBContextMenuEntry[]): CBContextMenuEntry[] {
  const titleEntries: CBContextMenuEntry[] = [];
  const normalEntries: CBContextMenuEntry[] = [];
  const forgeEntries: CBContextMenuEntry[] = [];
  const dangerEntries: CBContextMenuEntry[] = [];

  for (const entry of entries) {
    if (entry.sep) continue;
    if (entry.title) {
      titleEntries.push(entry);
    } else if (entry.danger) {
      dangerEntries.push(entry);
    } else if (entry.forge) {
      forgeEntries.push(entry);
    } else {
      normalEntries.push(entry);
    }
  }

  const ordered: CBContextMenuEntry[] = [...titleEntries, ...normalEntries];
  if (forgeEntries.length > 0) {
    if (ordered.length > titleEntries.length) ordered.push({ sep: true });
    ordered.push(...forgeEntries);
  }
  if (dangerEntries.length > 0) {
    if (ordered.length > titleEntries.length) ordered.push({ sep: true });
    ordered.push(...dangerEntries);
  }
  return ordered;
}

export function menuIconForId(id: string): string {
  switch (id) {
    case 'open': return 'folder';
    case 'new-folder': return 'folder-plus';
    case 'rename': return 'pencil';
    case 'duplicate': return 'copy';
    case 'delete': return 'trash-2';
    case 'copy-guid': return 'hash';
    case 'copy-path': return 'copy';
    case 'add-to-scene': return 'box';
    case 'assign': return 'crosshair';
    case 'add-to-chat':
    case 'add-folder-chat':
    case 'add-folder-summary':
    case 'add-with-deps': return 'spark';
    case 'toggle-fav': return 'star';
    default: return 'file';
  }
}

export function fileSpecificMenuItems(
  t: TFunction,
  file: { family: CBFileFamily },
): { id: string; label: string; icon: string; disabled?: boolean }[] {
  switch (file.family) {
    case 'doc':
      return [{ id: 'render-preview', label: t('editor.contentBrowser.contextMenu.renderPreview'), icon: 'eye' }];
    case 'code':
      return [
        { id: 'open-external-ide', label: t('editor.contentBrowser.contextMenu.openExternalIde'), icon: 'square-arrow-out-up-right', disabled: true },
        { id: 'rename-symbol', label: t('editor.contentBrowser.contextMenu.renameSymbol'), icon: 'text-cursor-input', disabled: true },
      ];
    case 'scene':
      return [
        { id: 'play', label: t('editor.contentBrowser.contextMenu.play'), icon: 'play', disabled: true },
        { id: 'set-default-scene', label: t('editor.contentBrowser.contextMenu.setDefaultScene'), icon: 'flag', disabled: true },
        { id: 'expand-sub-assets', label: t('editor.contentBrowser.contextMenu.expandSubAssets'), icon: 'chevrons-up-down' },
      ];
    case 'pack':
      return [
        { id: 'expand-sub-assets', label: t('editor.contentBrowser.contextMenu.expandSubAssets'), icon: 'chevrons-up-down' },
        { id: 'reimport', label: t('editor.contentBrowser.contextMenu.reimport'), icon: 'refresh-cw', disabled: true },
        { id: 'copy-guid', label: t('editor.contentBrowser.contextMenu.copyGuid'), icon: 'hash' },
      ];
    case 'meta':
      return [
        { id: 'expand-sub-assets', label: t('editor.contentBrowser.contextMenu.expandSubAssets'), icon: 'chevrons-up-down' },
        { id: 'reimport', label: t('editor.contentBrowser.contextMenu.reimport'), icon: 'refresh-cw', disabled: true },
        { id: 'locate-source-file', label: t('editor.contentBrowser.contextMenu.locateSourceFile'), icon: 'crosshair', disabled: true },
        { id: 'copy-guid', label: t('editor.contentBrowser.contextMenu.copyGuid'), icon: 'hash' },
      ];
    case 'model':
      return [
        { id: 'import-as-asset', label: t('editor.contentBrowser.contextMenu.importAsAsset'), icon: 'box', disabled: true },
        { id: 'reimport', label: t('editor.contentBrowser.contextMenu.reimport'), icon: 'refresh-cw', disabled: true },
        { id: 'generate-meta', label: t('editor.contentBrowser.contextMenu.generateMeta'), icon: 'file-cog', disabled: true },
      ];
    case 'image':
      return [
        { id: 'import-as-texture', label: t('editor.contentBrowser.contextMenu.importAsTexture'), icon: 'image', disabled: true },
        { id: 'set-as-icon', label: t('editor.contentBrowser.contextMenu.setAsIcon'), icon: 'app-window', disabled: true },
      ];
    case 'audio':
      return [
        { id: 'import-as-audio', label: t('editor.contentBrowser.contextMenu.importAsAudio'), icon: 'music', disabled: true },
        { id: 'audition', label: t('editor.contentBrowser.contextMenu.audition'), icon: 'play' },
      ];
    case 'font':
      return [{ id: 'import-as-font', label: t('editor.contentBrowser.contextMenu.importAsFont'), icon: 'type', disabled: true }];
    case 'data':
      return [{ id: 'visualize-in-scene', label: t('editor.contentBrowser.contextMenu.visualizeInScene'), icon: 'box-select', disabled: true }];
    default:
      return [];
  }
}

// ── Registry catalog entry → CBAsset ────────────────────────────────────────

export function registryEntryToCBAsset(e: RegistryCatalogEntry, index: number): CBAsset {
  // packPath is the CRUD target on disk — NOT the runtime load URL. For an
  // internal `.pack.json` asset the two coincide (relativeUrl IS the pack). For
  // an external import (FBX/GLB/HDR/audio/font) relativeUrl points at a DDC
  // artefact (`*.{guid}.bin` or `/__forgeax-ddc/{guid}.pack.json`) that has no
  // stable mapping back to the source; the CRUD target is the `.meta.json`
  // sidecar beside the source file. The engine surfaces that source location as
  // `sourcePath`; derive the sidecar path from it. Fallback to relativeUrl for
  // inline/dev entries that never went through pack-index (no sidecar, no CRUD).
  const packPath = (e.relativeUrl.includes('__forgeax-ddc'))
    ? (e.sourcePath ? `${e.sourcePath.replace(/^\//, '')}.meta.json` : e.relativeUrl)
    : e.relativeUrl.endsWith('.pack.json')
      ? e.relativeUrl
      : e.sourcePath
        ? `${e.sourcePath.replace(/^\//, '')}.meta.json`
        : e.relativeUrl;
  return {
    type: 'asset',
    guid: e.guid,
    kind: e.kind,
    name: e.name ?? e.guid.slice(0, 8),
    payload: {},
    packPath,
    packIndex: index,
    refs: e.refs ? [...e.refs] : [],
    estimatedSize: 0,
  };
}
