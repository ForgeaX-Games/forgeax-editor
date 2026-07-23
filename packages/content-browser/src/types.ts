/**
 * Content Browser V2 — type definitions.
 *
 * Aligned with engine `pack.schema.json`:
 *   - guid: RFC 4122 36-char dash-form UUID (UUIDv7 for new assets)
 *   - kind: open string; built-in filter metadata is constrained by engine Asset['kind']
 *   - payload: free-form object (validated by engine at load time)
 *   - refs: GUID cross-references array
 *
 * These types are browser-internal and do NOT modify engine types.
 */

// ── Core data models ─────────────────────────────────────────────────────────

export interface CBItem {
  type: 'asset' | 'folder' | 'file';
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

export type CBFileFamily =
  | 'code'
  | 'config'
  | 'doc'
  | 'scene'
  | 'pack'
  | 'meta'
  | 'image'
  | 'audio'
  | 'model'
  | 'font'
  | 'data'
  | 'other';

export interface CBFile extends CBItem {
  type: 'file';
  /** Game-relative display path, e.g. `assets/player.glb`. */
  path: string;
  /** Host-resolvable path for /api/files endpoints. */
  diskPath: string;
  name: string;
  family: CBFileFamily;
  /** Assets declared by this file when the registry can map them back. */
  assets: CBAsset[];
  /** Short display text in the prototype's family badge position. */
  kindLabel: string;
  isFavorite: boolean;
}

// ── Selection ────────────────────────────────────────────────────────────────

export interface CBSelection {
  /** All currently selected items (ordered by selection time). */
  items: (CBAsset | CBFolder | CBFile)[];
  /** The last-clicked item (anchor for range select). */
  primary: CBAsset | CBFolder | CBFile | null;
}

// ── Filter ───────────────────────────────────────────────────────────────────

/** Filter axis = file family (design's `FE_FILTERABLE`) plus the synthetic
 * `dir` bucket for folders. Mirrors the interaction spec's family taxonomy. */
export type CBFilterFamily = CBFileFamily | 'dir';

export interface CBFilter {
  /** Stable id, `family:${family}`. */
  id: string;
  family: CBFilterFamily;
  label: string;
  /** PascalCase lucide-react icon name (resolved by the panel menu renderer). */
  icon?: string;
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

/** Union of renderable items in the right-side content view (folders + assets). */
export type CBViewItem = CBAsset | CBFolder | CBFile;

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

/**
 * @deprecated Navigation history now lives in editor-core's session-domain
 * store (packages/core/src/store/cb-nav.ts, module-private CBNavEntry).
 * This type has zero consumers in this package as of
 * feat-20260708-cb-nav-session-op-convergence (useNavHistory.ts is now a
 * thin gateway shim). Retained per plan-strategy D-4 (no core<->CB type
 * coupling); slated for removal in a future cleanup pass.
 */
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
