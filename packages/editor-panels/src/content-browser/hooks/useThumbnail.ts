import { useMemo } from 'react';
import type { CBAsset } from '../types';

export interface ThumbnailData {
  type: 'icon' | 'swatch' | 'gradient' | 'image';
  icon?: string;
  color?: string;
  gradient?: string;
  badge?: string;
  /** Actual image URL for texture/image thumbnail previews. */
  imageUrl?: string;
}

const KIND_ICONS: Record<string, string> = {
  mesh: '◫', texture: '🖼', image: '🖼', 'cube-texture': '🧊', sampler: '⚙',
  material: '🎨', scene: '🗺', shader: '📜', skeleton: '🦴',
  skin: '🩻', 'animation-clip': '🎬', animation: '🎬', audio: '🔊', font: '🔤',
  'render-pipeline': '🔧', tileset: '🧱',
};

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

function shaderPreview(payload: Record<string, unknown>): string | undefined {
  const src = payload.source;
  if (typeof src === 'string') return src.slice(0, 60).trim();
  return undefined;
}

function resolveImageUrl(asset: CBAsset): string | undefined {
  const source = asset.payload?.source as string | undefined;
  if (!source) return undefined;
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

export function getThumbnailData(asset: CBAsset): ThumbnailData {
  const { kind, payload } = asset;

  if (kind === 'material') {
    return { type: 'gradient', gradient: materialGradient(payload) };
  }

  if (kind === 'texture' || kind === 'image') {
    const imageUrl = resolveImageUrl(asset);
    if (imageUrl) {
      return { type: 'image', imageUrl, icon: '🖼', color: KIND_COLORS.texture, badge: textureBadge(payload) };
    }
    return { type: 'icon', icon: '🖼', color: KIND_COLORS.texture, badge: textureBadge(payload) };
  }

  if (kind === 'mesh') {
    return { type: 'icon', icon: KIND_ICONS.mesh, color: KIND_COLORS.mesh, badge: meshBadge(payload) };
  }

  if (kind === 'scene') {
    return { type: 'icon', icon: KIND_ICONS.scene, color: KIND_COLORS.scene, badge: sceneBadge(payload) };
  }

  if (kind === 'animation-clip') {
    const channels = (payload as { channels?: unknown[] }).channels;
    const badge = Array.isArray(channels) ? `${channels.length} ch` : undefined;
    return { type: 'icon', icon: KIND_ICONS['animation-clip'], color: KIND_COLORS['animation-clip'], badge };
  }

  return {
    type: 'icon',
    icon: KIND_ICONS[kind] ?? '📦',
    color: KIND_COLORS[kind],
  };
}

export function useThumbnail(asset: CBAsset): ThumbnailData {
  return useMemo(() => getThumbnailData(asset), [asset.guid, asset.kind]);
}
