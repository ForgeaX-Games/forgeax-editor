import {
  Bone,
  Box,
  Braces,
  ChevronDown,
  Clapperboard,
  Database,
  File,
  FileCode2,
  FileText,
  Film,
  Folder,
  FolderOpen,
  Globe,
  Image,
  Layers,
  Music,
  Package,
  Paintbrush,
  Star,
  Type,
  type LucideIcon,
} from 'lucide-react';
import type { CBFileFamily } from './types';

export const FILE_FAMILY_ICON_NAMES = {
  dir: 'folder',
  code: 'file-code',
  config: 'braces',
  doc: 'file-text',
  scene: 'clapperboard',
  pack: 'package',
  meta: 'layers',
  image: 'image',
  audio: 'music',
  model: 'box',
  font: 'type',
  data: 'database',
  other: 'file',
} as const satisfies Record<CBFileFamily | 'dir', string>;

export const ASSET_KIND_ICON_NAMES: Readonly<Record<string, string>> = {
  mesh: 'box',
  texture: 'image',
  image: 'image',
  'cube-texture': 'globe',
  material: 'paintbrush',
  scene: 'clapperboard',
  skeleton: 'bone',
  'animation-clip': 'film',
  audio: 'music',
  font: 'type',
};

export const FILE_FAMILY_COLORS = {
  dir: '#c9a86a',
  code: 'var(--accent-cyan, #6cc4ff)',
  config: 'var(--accent-amber, #ffc966)',
  doc: 'var(--text-secondary, rgba(255, 255, 255, 0.60))',
  scene: 'var(--accent-violet, #7c5cff)',
  pack: 'var(--accent-mint, #63eacf)',
  meta: 'var(--accent-orange, #ffb056)',
  image: 'var(--accent-green, #4fd17f)',
  audio: 'var(--accent-pink, #ff6db8)',
  model: 'var(--accent-cyan, #6cc4ff)',
  font: '#e0d060',
  data: 'var(--text-mute, rgba(255, 255, 255, 0.30))',
  other: 'var(--text-mute, rgba(255, 255, 255, 0.30))',
} as const satisfies Record<CBFileFamily | 'dir', string>;

export const ASSET_KIND_COLORS: Readonly<Record<string, string>> = {
  mesh: 'var(--accent-cyan, #6cc4ff)',
  texture: 'var(--accent-green, #4fd17f)',
  image: 'var(--accent-green, #4fd17f)',
  'cube-texture': 'var(--accent-mint, #63eacf)',
  material: 'var(--accent-orange, #ffb056)',
  scene: 'var(--accent-violet, #7c5cff)',
  skeleton: '#d8c7ff',
  'animation-clip': 'var(--accent-pink, #ff6db8)',
  audio: 'var(--accent-pink, #ff6db8)',
  font: '#e0d060',
};

const ICONS: Record<string, LucideIcon> = {
  bone: Bone,
  box: Box,
  braces: Braces,
  clapperboard: Clapperboard,
  database: Database,
  file: File,
  'file-code': FileCode2,
  'file-text': FileText,
  film: Film,
  folder: Folder,
  'folder-open': FolderOpen,
  globe: Globe,
  image: Image,
  layers: Layers,
  music: Music,
  package: Package,
  paintbrush: Paintbrush,
  star: Star,
  type: Type,
  'chevron-down': ChevronDown,
};

export function iconNameForFileFamily(family: CBFileFamily): string {
  return FILE_FAMILY_ICON_NAMES[family] ?? FILE_FAMILY_ICON_NAMES.other;
}

export function iconNameForAssetKind(kind: string): string {
  return ASSET_KIND_ICON_NAMES[kind] ?? 'package';
}

export function colorForFileFamily(family: CBFileFamily): string {
  return FILE_FAMILY_COLORS[family] ?? FILE_FAMILY_COLORS.other;
}

export function colorForAssetKind(kind: string): string {
  return ASSET_KIND_COLORS[kind] ?? 'var(--text-mute, rgba(255, 255, 255, 0.30))';
}

export function ContentBrowserIcon({ name, className }: { name: string; className?: string }) {
  const Icon = ICONS[name] ?? File;
  return <Icon className={className} aria-hidden="true" />;
}

export function FileFamilyIcon({ family, className }: { family: CBFileFamily; className?: string }) {
  return <ContentBrowserIcon name={iconNameForFileFamily(family)} className={className} />;
}
