import type { Asset } from '@forgeax/engine-types';
import type { CBAsset, CBFilter } from './types';

/** Built-in presentation metadata keyed by the engine's closed Asset union.
 * Engine kind additions/removals therefore fail editor typecheck instead of
 * silently drifting the Assets panel's "All Types" menu. */
export const BUILTIN_ASSET_KIND_FILTERS = {
  mesh: { label: 'Mesh', icon: '◫' },
  texture: { label: 'Texture', icon: '🖼' },
  equirect: { label: 'Equirect', icon: '🌐' },
  sampler: { label: 'Sampler', icon: '⚙' },
  material: { label: 'Material', icon: '🎨' },
  scene: { label: 'Scene', icon: '🗺' },
  shader: { label: 'Shader', icon: '📜' },
  skeleton: { label: 'Skeleton', icon: '🦴' },
  skin: { label: 'Skin', icon: '🩻' },
  'animation-clip': { label: 'Animation Clip', icon: '🎬' },
  'animation-graph': { label: 'Animation Graph', icon: '🕸' },
  audio: { label: 'Audio', icon: '🔊' },
  font: { label: 'Font', icon: '🔤' },
  'render-pipeline': { label: 'Render Pipeline', icon: '🔧' },
  tileset: { label: 'Tileset', icon: '🧱' },
  video: { label: 'Video', icon: '📹' },
} satisfies Record<Asset['kind'], { readonly label: string; readonly icon: string }>;

const GENERIC_ASSET_ICON = '◇';

/** Open-string pack kinds remain discoverable for plugins and future assets. */
export function formatAssetKindLabel(kind: string): string {
  const words = kind.trim().split(/[-_\s]+/u).filter(Boolean);
  if (words.length === 0) return 'Unknown';
  return words
    .map(word => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

function makeFilter(kind: string, label: string, icon: string): CBFilter {
  return {
    id: `kind:${kind}`,
    label,
    icon,
    predicate: (item: CBAsset) => item.kind === kind,
    active: false,
  };
}

/** Build built-in filters plus deterministic catalog-only custom kinds. */
export function buildKindFilters(observedKinds: readonly string[] = []): CBFilter[] {
  const builtIn = Object.entries(BUILTIN_ASSET_KIND_FILTERS).map(
    ([kind, spec]) => makeFilter(kind, spec.label, spec.icon),
  );
  const customKinds = [...new Set(observedKinds)]
    .filter(kind => kind.trim().length > 0 && !Object.hasOwn(BUILTIN_ASSET_KIND_FILTERS, kind))
    .sort((a, b) => a.localeCompare(b));

  return [
    ...builtIn,
    ...customKinds.map(kind => makeFilter(kind, formatAssetKindLabel(kind), GENERIC_ASSET_ICON)),
  ];
}
