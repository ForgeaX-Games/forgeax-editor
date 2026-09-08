// uv-chart.ts — Pure UV layout charting helpers for the UV Editor panel (P1.5).
//
// The UV Editor draws a 2D展开图 of a mesh's UV channels: each triangle's
// three edges are stroked in UV ([0,1]×[0,1]) space. This module holds the
// pure geometry extraction so the React component stays a thin Canvas2D
// renderer and the segment math is unit-testable without a DOM.
//
// Input shape mirrors the engine MeshAsset POD (`attributes.uv` / `uv1..uv7`
// as Float32Array | Uint16Array | number[], `indices` as Uint16Array |
// Uint32Array | number[], `submeshes` as { indexOffset, indexCount,
// topology }[]). Values are read by index so they tolerate both typed arrays
// and the plain-array shapes a cross-realm runtime projection may deliver.

export interface UvSegment {
  /** Segment start in UV space. */
  readonly ax: number;
  readonly ay: number;
  /** Segment end in UV space. */
  readonly bx: number;
  readonly by: number;
  /** Submesh index, for per-channel coloring. */
  readonly submesh: number;
}

export interface UvSubmeshRange {
  readonly indexOffset: number;
  readonly indexCount: number;
  readonly topology?: string;
}

/** Canonical UV attribute key order (mirrors engine UV_ATTRIBUTE_KEYS). */
export const UV_CHANNEL_KEYS = ['uv', 'uv1', 'uv2', 'uv3', 'uv4', 'uv5', 'uv6', 'uv7'] as const;
export type UvChannelKey = (typeof UV_CHANNEL_KEYS)[number];

/** Read two floats (u, v) at vertex index `vi` from a UV attribute buffer. */
function readUv(buffer: ArrayLike<number>, vi: number): { readonly u: number; readonly v: number } | null {
  const base = vi * 2;
  const u = buffer[base];
  const v = buffer[base + 1];
  if (u === undefined || v === undefined || Number.isNaN(u) || Number.isNaN(v)) return null;
  return { u, v };
}

/**
 * Extract the wireframe segments of one UV channel.
 *
 * Only `triangle-list` topology contributes edges (the engine's primary mesh
 * topology); other topologies are skipped to avoid drawing meaningless
 * segments. Each triangle contributes 3 edges; shared interior edges are
 * drawn twice (once per adjacent triangle), matching UE's UV overlay look —
 * dedup would hide overlap diagnostics, which is the point of the panel.
 *
 * Returns the empty array when the channel is missing or the mesh has no
 * triangle indices.
 */
export function computeUvSegments(
  uv: ArrayLike<number> | undefined,
  indices: ArrayLike<number> | undefined,
  submeshes: readonly UvSubmeshRange[],
): readonly UvSegment[] {
  if (uv === undefined || indices === undefined || submeshes.length === 0) return [];
  const segments: UvSegment[] = [];
  for (let s = 0; s < submeshes.length; s += 1) {
    const submesh = submeshes[s]!;
    if (submesh.topology !== undefined && submesh.topology !== 'triangle-list') continue;
    const offset = submesh.indexOffset;
    const count = submesh.indexCount;
    for (let i = 0; i < count; i += 3) {
      const i0 = indices[offset + i];
      const i1 = indices[offset + i + 1];
      const i2 = indices[offset + i + 2];
      if (i0 === undefined || i1 === undefined || i2 === undefined) continue;
      const p0 = readUv(uv, i0);
      const p1 = readUv(uv, i1);
      const p2 = readUv(uv, i2);
      if (p0 === null || p1 === null || p2 === null) continue;
      segments.push({ ax: p0.u, ay: p0.v, bx: p1.u, by: p1.v, submesh: s });
      segments.push({ ax: p1.u, ay: p1.v, bx: p2.u, by: p2.v, submesh: s });
      segments.push({ ax: p2.u, ay: p2.v, bx: p0.u, by: p0.v, submesh: s });
    }
  }
  return segments;
}

/**
 * List the UV channels present in a vertex attribute map (in canonical order).
 * Accepts the engine `VertexAttributeMap` shape or its `Record<string, unknown>`
 * projection; a channel counts as present when its value is a non-empty
 * array-like.
 */
export function listUvChannels(attributes: Record<string, unknown> | undefined): readonly UvChannelKey[] {
  if (attributes === undefined) return [];
  const present: UvChannelKey[] = [];
  for (const key of UV_CHANNEL_KEYS) {
    const value = attributes[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') continue;
    if (typeof (value as ArrayLike<unknown>).length === 'number' && (value as ArrayLike<unknown>).length >= 2) {
      present.push(key);
    }
  }
  return present;
}

/** Normalize a UV coordinate into [0,1] for display (wraps out-of-range UVs
 *  back into the unit tile so the chart stays bounded). */
export function normalizeUv(value: number): number {
  if (Number.isNaN(value)) return 0;
  return value - Math.floor(value);
}
