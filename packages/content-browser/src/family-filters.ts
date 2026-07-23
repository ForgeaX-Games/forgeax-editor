// Content Browser filter axis — file FAMILY, ported 1:1 from the interaction
// spec (forgeax-studio-demo `FAMILY` map). The filter offers a FIXED set of the
// spec-defined families (dir/scene/pack/meta/model/image/audio/font/code/config/
// doc/data) — it is a static type filter, independent of what the current folder
// happens to contain (a family with no matching content simply filters to an
// empty list). Icons reuse the shared lucide set already used by the CB rows
// (see content-browser-icons.tsx), so the filter menu matches the tree glyphs.

import type { CBFilterFamily } from './types';

/** The fixed, spec-defined filter families in display order (`dir` first).
 * `other` is intentionally absent: the spec defines no "other" chip. */
export const ALL_FILTER_FAMILIES: readonly CBFilterFamily[] = [
  'dir', 'scene', 'pack', 'meta', 'model', 'image', 'audio', 'font', 'code', 'config', 'doc', 'data',
];

/** family → PascalCase lucide-react name (must exist in the panel menu's ICONS
 * map). Matches content-browser-icons `FILE_FAMILY_ICON_NAMES` glyph choices. */
export const FAMILY_FILTER_ICON: Record<CBFilterFamily, string> = {
  dir: 'Folder',
  code: 'FileCode2',
  config: 'Braces',
  doc: 'FileText',
  scene: 'Clapperboard',
  pack: 'Package',
  meta: 'Layers',
  image: 'Image',
  audio: 'Music',
  model: 'Box',
  font: 'Type',
  data: 'Database',
  other: 'File',
};
