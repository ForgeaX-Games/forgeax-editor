// AssetThumbnail — the ONE asset-preview primitive shared by every editor
// surface (Content Browser cards, Inspector asset fields, pickers). Both the
// kind→visual mapping (`getThumbnailData`) and the compact box renderer live
// here in editor-ui so consumers reference a single primitive instead of one
// panel importing another panel's copy.
//
// Input is a minimal structural shape (`kind` + free-form `payload` + optional
// `packPath`), so any catalogue/descriptor row satisfies it without dragging a
// domain type into this base package.

import { useState, type CSSProperties } from 'react';
import {
  Box, Image as ImageIcon, Globe, Paintbrush, Clapperboard, Braces, Bone,
  PersonStanding, Film, Music, Type, Settings, LayoutGrid, Package,
  type LucideIcon,
} from 'lucide-react';

export interface AssetThumbnailInput {
  /** Engine asset kind discriminant, e.g. 'mesh' | 'texture' | 'material'. */
  kind: string;
  /** Free-form serialized asset payload (baseColor, width/height, source, …). */
  payload?: Record<string, unknown> | undefined;
  /** Path to the owning `.pack.json`; lets texture/image kinds resolve a real
   *  image URL. Omit → glyph fallback. */
  packPath?: string | undefined;
}

export interface ThumbnailData {
  type: 'icon' | 'swatch' | 'gradient' | 'image';
  color?: string;
  gradient?: string;
  badge?: string;
  /** Actual image URL for texture/image thumbnail previews. */
  imageUrl?: string;
}

// Kind → lucide glyph. This is the rendered SSOT for every icon-type preview
// (Content Browser cards, Inspector fields, pickers). Vector glyphs only — no
// emoji — so scene reads as the same clapperboard everywhere else in the UI.
const KIND_GLYPHS: Record<string, LucideIcon> = {
  mesh: Box, texture: ImageIcon, image: ImageIcon, 'cube-texture': Globe,
  sampler: Settings, material: Paintbrush, scene: Clapperboard, shader: Braces,
  skeleton: Bone, skin: PersonStanding, 'animation-clip': Film, animation: Film,
  audio: Music, font: Type, 'render-pipeline': Settings, tileset: LayoutGrid,
};

/** Renders the vector glyph for an asset kind (falls back to a generic box). */
export function AssetKindGlyph({ kind, size = 16, className }: { kind: string; size?: number; className?: string }) {
  const Glyph = KIND_GLYPHS[kind] ?? Package;
  return <Glyph size={size} className={className} aria-hidden="true" />;
}

const KIND_COLORS: Record<string, string> = {
  mesh: '#4a6b8a', texture: '#6a8a4a', image: '#6a8a4a', 'cube-texture': '#4a8a8a',
  sampler: '#8a6a4a', material: '#8a4a6a', scene: '#4a8a6a',
  shader: '#6a4a8a', skeleton: '#8a8a4a', skin: '#4a4a8a',
  'animation-clip': '#8a4a4a', animation: '#8a4a4a', audio: '#4a8a4a', font: '#6a6a8a',
  'render-pipeline': '#8a6a6a', tileset: '#6a8a6a',
};

function extractBaseColor(payload: Record<string, unknown>): [number, number, number, number] | null {
  const pv = payload.paramValues as Record<string, unknown> | undefined;
  if (!pv) return null;
  const bc = pv.baseColor;
  if (!Array.isArray(bc) || bc.length < 3) return null;
  return [bc[0] as number, bc[1] as number, bc[2] as number, bc[3] as number ?? 1];
}

function toCSS(rgba: [number, number, number, number]): string {
  return `rgba(${Math.round(rgba[0] * 255)}, ${Math.round(rgba[1] * 255)}, ${Math.round(rgba[2] * 255)}, ${rgba[3]})`;
}

function materialGradient(payload: Record<string, unknown>): string {
  const bc = extractBaseColor(payload);
  if (!bc) return 'radial-gradient(circle at 35% 35%, #aaa 0%, #444 70%, #222 100%)';
  const base = toCSS(bc);
  const light = toCSS([Math.min(1, bc[0] + 0.3), Math.min(1, bc[1] + 0.3), Math.min(1, bc[2] + 0.3), 1]);
  const dark = toCSS([bc[0] * 0.3, bc[1] * 0.3, bc[2] * 0.3, 1]);
  return `radial-gradient(circle at 35% 35%, ${light} 0%, ${base} 50%, ${dark} 100%)`;
}

function meshBadge(payload: Record<string, unknown>): string | undefined {
  const submeshes = payload.submeshes;
  if (Array.isArray(submeshes) && submeshes.length > 0) {
    return `${submeshes.length} mesh${submeshes.length > 1 ? 'es' : ''}`;
  }
  return undefined;
}

function sceneBadge(payload: Record<string, unknown>): string | undefined {
  const nodes = payload.nodes;
  if (Array.isArray(nodes)) return `${nodes.length} node${nodes.length !== 1 ? 's' : ''}`;
  const entities = payload.entities;
  if (Array.isArray(entities)) return `${entities.length} entity`;
  return undefined;
}

function resolveImageUrl(asset: AssetThumbnailInput): string | undefined {
  const source = asset.payload?.source as string | undefined;
  if (!source || !asset.packPath) return undefined;
  const packDir = asset.packPath.replace(/[^/]+$/, '');
  const sourcePath = `${packDir}${source}`;
  return `/api/files/raw?path=${encodeURIComponent(sourcePath)}`;
}

function textureBadge(payload: Record<string, unknown>): string | undefined {
  const w = payload.width as number | undefined;
  const h = payload.height as number | undefined;
  if (w != null && h != null) return `${w}×${h}`;
  return undefined;
}

/** Pure kind→visual mapping. SSOT for every asset preview in the editor. */
export function getThumbnailData(asset: AssetThumbnailInput): ThumbnailData {
  const { kind } = asset;
  const payload = asset.payload ?? {};

  if (kind === 'material') {
    return { type: 'gradient', gradient: materialGradient(payload) };
  }

  if (kind === 'texture' || kind === 'image') {
    const imageUrl = resolveImageUrl(asset);
    if (imageUrl) {
      return { type: 'image', imageUrl, color: KIND_COLORS.texture, badge: textureBadge(payload) };
    }
    return { type: 'icon', color: KIND_COLORS.texture, badge: textureBadge(payload) };
  }

  if (kind === 'mesh') {
    return { type: 'icon', color: KIND_COLORS.mesh, badge: meshBadge(payload) };
  }

  if (kind === 'scene') {
    return { type: 'icon', color: KIND_COLORS.scene, badge: sceneBadge(payload) };
  }

  if (kind === 'animation-clip') {
    const channels = (payload as { channels?: unknown[] }).channels;
    const badge = Array.isArray(channels) ? `${channels.length} ch` : undefined;
    return { type: 'icon', color: KIND_COLORS['animation-clip'], badge };
  }

  return {
    type: 'icon',
    color: KIND_COLORS[kind],
  };
}

export interface AssetThumbnailProps extends AssetThumbnailInput {
  /** Square edge length in px. */
  size?: number;
  /** How the image fits its box. `cover` for compact chips, `contain` for a
   *  faithful hero preview (no cropping). Defaults to `cover`. */
  fit?: 'cover' | 'contain';
  /** Native title tooltip. */
  title?: string;
  className?: string;
  style?: CSSProperties;
}

/** Compact self-styled preview square: image / material sphere / kind glyph. */
export function AssetThumbnail({ kind, payload, packPath, size = 16, fit = 'cover', title, className, style }: AssetThumbnailProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const thumb = getThumbnailData({ kind, payload, packPath });
  const box: CSSProperties = {
    width: size, height: size, minWidth: size, flex: '0 0 auto',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden', borderRadius: Math.max(2, Math.round(size * 0.2)),
    border: '1px solid var(--color-border-default, rgba(255,255,255,0.14))',
    fontSize: Math.round(size * 0.6), lineHeight: 1,
    ...style,
  };
  if (thumb.type === 'image' && thumb.imageUrl && !imgFailed) {
    // Checkerboard backdrop so transparent textures read clearly (esp. under
    // `contain`, where the box is not fully covered).
    const checker = 'repeating-conic-gradient(rgba(255,255,255,0.09) 0% 25%, rgba(0,0,0,0.18) 0% 50%) 50% / 12px 12px';
    return (
      <span className={className} style={{ ...box, background: checker }} title={title}>
        <img src={thumb.imageUrl} alt="" onError={() => setImgFailed(true)} style={{ width: '100%', height: '100%', objectFit: fit }} />
      </span>
    );
  }
  if (thumb.type === 'gradient' && thumb.gradient) {
    // Keep the material sphere perfectly round regardless of box proportions.
    return (
      <span className={className} style={box} title={title}>
        <span style={{ width: '82%', aspectRatio: '1 / 1', borderRadius: '50%', background: thumb.gradient, boxShadow: 'inset -3px -3px 6px rgba(0,0,0,0.4), inset 2px 2px 5px rgba(255,255,255,0.15)' }} />
      </span>
    );
  }
  return (
    <span className={className} style={{ ...box, color: 'var(--color-text-tertiary, #8a8a8a)' }} title={title}>
      <AssetKindGlyph kind={kind} size={Math.round(size * 0.6)} />
    </span>
  );
}
