/**
 * Cross-panel type definitions shared between editor-core and consumer panels.
 *
 * These types are NOT part of the VAG_* iframe protocol (which lives in
 * protocol.ts) — they are plain data shapes consumed through store
 * subscriptions and postMessage bridges. Formerly resided in sync-channel.ts
 * (M1 w4 relocation per plan-strategy D2).
 *
 * Constraints: plan-strategy §2 D2 (new independent file, not protocol.ts);
 * research Finding 1a (AssetChatRef in sync-channel.ts:172 vs editor-panels/
 * content-browser/types.ts:107 — this file hosts the core-side definition;
 * editor-panels' local copy is untouched).
 */

/** Derived, geometry-free mesh statistics for the Mesh panel (wire shape). */
export interface MeshStatsWire {
  /** GUID of the mesh sub-asset these stats describe. */
  guid: string;
  vertexCount: number;
  /** Total primitives across submeshes (per-topology: tri/line/point). */
  primitiveCount: number;
  indexFormat: 'u16' | 'u32' | 'none';
  submeshes: readonly { topology: string; indexCount: number; vertexCount: number; primitiveCount: number }[];
  /** Local-space AABB [minX,minY,minZ,maxX,maxY,maxZ], if known. */
  aabb?: readonly number[];
  attributes: readonly string[];
  /** CPU geometry byte size = vertices.byteLength + indices.byteLength. This is
   *  the host-side geometry footprint, NOT the GPU resource size (which would
   *  include alignment/padding) — see editor-mesh-panel-ue58-parity.md §6.4. */
  byteSize?: number;
  /** Set when the mesh could not be loaded (registry miss / bad guid). */
  error?: string;
}

/** Reference payload for AI Chat context injection (M5). */
export interface AssetChatRef {
  type: 'asset' | 'folder';
  guid?: string;
  kind?: string;
  name: string;
  path: string;
  payload?: Record<string, unknown>;
  summary?: { totalAssets: number; kinds: Record<string, number>; guids: string[] };
}