/**
 * Content Browser V2 — type definitions.
 *
 * Aligned with engine `pack.schema.json`:
 *   - guid: RFC 4122 36-char dash-form UUID (UUIDv7 for new assets)
 *   - kind: open string at schema level; closed union at browser filter level
 *   - payload: free-form object (validated by engine at load time)
 *   - refs: GUID cross-references array
 *
 * These types are browser-internal and do NOT modify engine types.
 */

// ── Asset Kinds (mirrors engine Asset union discriminants) ────────────────────

export const ASSET_KINDS = [
  'mesh', 'texture', 'image', 'cube-texture', 'sampler', 'material', 'scene',
  'shader', 'skeleton', 'skin', 'animation-clip', 'audio', 'font',
  'render-pipeline', 'tileset',
] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

// ── Core data models ─────────────────────────────────────────────────────────

export interface CBItem {
  type: 'asset' | 'folder';
}

export interface CBAsset extends CBItem {
  type: 'asset';
  /** RFC 4122 UUIDv7 dash-form (36 chars). */
  guid: string;
  /** Engine asset kind discriminant. */
  kind: string;
  /** Display name from pack `assets[].name` or derived `<pack-stem> · <guid8>`. */
  name: string;
  /** Serialized asset payload (free-form object per engine schema). */
  payload: Record<string, unknown>;
  /** Full path to the `.pack.json` file containing this asset. */
  packPath: string;
  /** Zero-based index within the pack's `assets[]` array. */
  packIndex: number;
  /** GUID cross-references from pack `assets[].refs`. */
  refs: string[];
  /** Cached thumbnail data URL or endpoint URL. */
  thumbnailUrl?: string;
  /** Pack file mtime (all assets in the same pack share this value). */
  packModifiedAt?: number;
  /** Estimated payload size in bytes (`JSON.stringify(payload).length`). */
  estimatedSize?: number;
}

export interface CBFolder extends CBItem {
  type: 'folder';
  /** Relative path from game root. */
  path: string;
  /** Directory basename. */
  name: string;
  /** User-assigned color (persisted in localStorage). */
  color?: string;
  /** Whether this folder is in the favorites list. */
  isFavorite: boolean;
  /** Recursive asset count (computed on load). */
  childCount: number;
}

// ── Selection ────────────────────────────────────────────────────────────────

export interface CBSelection {
  /** All currently selected items (ordered by selection time). */
  items: (CBAsset | CBFolder)[];
  /** The last-clicked item (anchor for range select). */
  primary: CBAsset | CBFolder | null;
}

// ── Filter ───────────────────────────────────────────────────────────────────

export interface CBFilter {
  id: string;
  label: string;
  icon?: string;
  predicate: (item: CBAsset) => boolean;
  active: boolean;
}

// ── Sort ─────────────────────────────────────────────────────────────────────

export type CBSortKey = 'name' | 'kind' | 'packModifiedAt' | 'estimatedSize';
export type CBSortDir = 'asc' | 'desc';

export interface CBSortState {
  key: CBSortKey;
  dir: CBSortDir;
}

// ── View ─────────────────────────────────────────────────────────────────────

export type CBViewMode = 'grid' | 'list' | 'column';

export interface CBViewState {
  mode: CBViewMode;
  thumbnailSize: number;
}

// ── AI Chat integration ──────────────────────────────────────────────────────

export interface AssetChatRef {
  type: 'asset' | 'folder';
  guid?: string;
  kind?: string;
  name: string;
  path: string;
  payload?: Record<string, unknown>;
  /** Folder recursive summary. */
  summary?: {
    totalAssets: number;
    kinds: Record<string, number>;
    guids: string[];
  };
}

// ── Navigation history ───────────────────────────────────────────────────────

export interface CBNavEntry {
  path: string;
  timestamp: number;
}

// ── Pack file structure (mirrors engine pack.schema.json) ────────────────────

export interface PackFileAssetEntry {
  guid: string;
  kind: string;
  name?: string;
  payload: Record<string, unknown>;
  refs: string[];
}

export interface PackFile {
  schemaVersion: string;
  kind: 'internal-text-package';
  assets: PackFileAssetEntry[];
}
