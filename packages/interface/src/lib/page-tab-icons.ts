/**
 * Unified Lucide mapping for open document tabs — the SSOT for "what icon does
 * this page show". Mirrors the `iconForWorkbenchModule` pattern: one pure,
 * react-free resolver so the tab strip, overflow menu, and rules manual never
 * drift on icon semantics. Follow `DESIGN-SYSTEM.md` §icon rules — no ad-hoc
 * per-file lucide imports, no emoji.
 */
import {
  Box,
  Clapperboard,
  File,
  FileCode2,
  FileText,
  Image,
  Music,
  Package,
  Puzzle,
  Settings2,
  Type,
  type LucideIcon,
} from 'lucide-react';
import type { ResourceDescriptor } from '@forgeax/types';

/** Coarse content family a page belongs to — the axis icons key off. */
export type PageKind =
  | 'scene'
  | 'model'
  | 'image'
  | 'audio'
  | 'font'
  | 'pack'
  | 'code'
  | 'doc'
  | 'config'
  | 'plugin';

const ICON_BY_KIND: Record<PageKind, LucideIcon> = {
  scene: Clapperboard,
  model: Box,
  image: Image,
  audio: Music,
  font: Type,
  pack: Package,
  code: FileCode2,
  doc: FileText,
  config: Settings2,
  plugin: Puzzle,
};

const EXT_KIND: ReadonlyArray<readonly [readonly string[], PageKind]> = [
  [['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py'], 'code'],
  [['md', 'markdown', 'txt'], 'doc'],
  [['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico', 'hdr'], 'image'],
  [['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'opus'], 'audio'],
  [['glb', 'gltf', 'fbx'], 'model'],
  [['ttf', 'otf', 'woff2'], 'font'],
];

/** Derive the content family from a resource path, else from the page type id. */
export function pageKindOf(input: { typeId: string; resource?: ResourceDescriptor }): PageKind {
  const path = (input.resource?.displayPath ?? input.resource?.uri ?? '').toLowerCase();
  if (path) {
    if (path.endsWith('.scene.json')) return 'scene';
    if (path.endsWith('.pack.json')) return path.includes('scene') ? 'scene' : 'pack';
    const ext = path.split(/[?#]/u, 1)[0]?.split('.').pop() ?? '';
    for (const [exts, kind] of EXT_KIND) if (exts.includes(ext)) return kind;
    if (path.endsWith('forge.json') || path.endsWith('package.json')) return 'config';
  }
  const id = input.typeId.toLowerCase();
  for (const kind of Object.keys(ICON_BY_KIND) as PageKind[]) {
    if (id.includes(kind)) return kind;
  }
  if (id.includes('scene') || id.includes('level')) return 'scene';
  if (id.includes('workbench') || id.includes('wb-') || id.includes('plugin')) return 'plugin';
  return 'config';
}

/** Resolve the Lucide icon for a page. Never returns undefined. */
export function iconForPage(input: { typeId: string; resource?: ResourceDescriptor }): LucideIcon {
  const path = (input.resource?.displayPath ?? input.resource?.uri ?? '').toLowerCase();
  const kind = pageKindOf(input);
  // A resource-less, unclassifiable page falls back to a neutral file glyph
  // rather than a misleading "config" icon.
  if (!path && kind === 'config' && !input.typeId.toLowerCase().includes('config')) return File;
  return ICON_BY_KIND[kind];
}
