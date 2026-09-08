// Unit tests for the UV chart helpers (P1.5).
//
// computeUvSegments extracts the triangle wireframe of a UV channel; the
// segment math is pure so it is pinned here without a DOM/Canvas. The shape
// mirrors the engine MeshAsset POD (attributes.uv as Float32Array | number[],
// indices as Uint16Array | number[], submeshes as { indexOffset, indexCount,
// topology }[]).

import { describe, expect, it } from 'bun:test';
import {
  computeUvSegments,
  listUvChannels,
  normalizeUv,
  UV_CHANNEL_KEYS,
  type UvSubmeshRange,
} from '../uv-chart';

describe('computeUvSegments', () => {
  it('extracts 3 edges per triangle from a single-triangle mesh', () => {
    const uv = new Float32Array([0, 0, 1, 0, 0, 1]);
    const indices = new Uint16Array([0, 1, 2]);
    const submeshes: UvSubmeshRange[] = [{ indexOffset: 0, indexCount: 3, topology: 'triangle-list' }];
    const segments = computeUvSegments(uv, indices, submeshes);
    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({ ax: 0, ay: 0, bx: 1, by: 0, submesh: 0 });
    expect(segments[1]).toMatchObject({ ax: 1, ay: 0, bx: 0, by: 1, submesh: 0 });
    expect(segments[2]).toMatchObject({ ax: 0, ay: 1, bx: 0, by: 0, submesh: 0 });
  });

  it('handles two submeshes with per-submesh coloring and offsets', () => {
    const uv = new Float32Array([0, 0, 1, 0, 0, 1, 0.5, 0.5, 0.5, 0, 0, 0.5]);
    const indices = new Uint16Array([0, 1, 2, 3, 4, 5]);
    const submeshes: UvSubmeshRange[] = [
      { indexOffset: 0, indexCount: 3, topology: 'triangle-list' },
      { indexOffset: 3, indexCount: 3, topology: 'triangle-list' },
    ];
    const segments = computeUvSegments(uv, indices, submeshes);
    expect(segments).toHaveLength(6);
    expect(segments[0]!.submesh).toBe(0);
    expect(segments[3]!.submesh).toBe(1);
    expect(segments[3]).toMatchObject({ ax: 0.5, ay: 0.5, bx: 0.5, by: 0 });
  });

  it('skips non-triangle-list topologies', () => {
    const uv = new Float32Array([0, 0, 1, 0]);
    const indices = new Uint16Array([0, 1]);
    const submeshes: UvSubmeshRange[] = [{ indexOffset: 0, indexCount: 2, topology: 'line-list' }];
    expect(computeUvSegments(uv, indices, submeshes)).toEqual([]);
  });

  it('returns empty when uv is missing', () => {
    const indices = new Uint16Array([0, 1, 2]);
    const submeshes: UvSubmeshRange[] = [{ indexOffset: 0, indexCount: 3, topology: 'triangle-list' }];
    expect(computeUvSegments(undefined, indices, submeshes)).toEqual([]);
  });

  it('returns empty when indices are missing', () => {
    const uv = new Float32Array([0, 0, 1, 0, 0, 1]);
    const submeshes: UvSubmeshRange[] = [{ indexOffset: 0, indexCount: 3, topology: 'triangle-list' }];
    expect(computeUvSegments(uv, undefined, submeshes)).toEqual([]);
  });

  it('returns empty when there are no submeshes', () => {
    const uv = new Float32Array([0, 0, 1, 0, 0, 1]);
    const indices = new Uint16Array([0, 1, 2]);
    expect(computeUvSegments(uv, indices, [])).toEqual([]);
  });

  it('tolerates plain arrays (cross-realm projection shape)', () => {
    const uv = [0, 0, 1, 0, 0, 1] as number[];
    const indices = [0, 1, 2] as number[];
    const submeshes: UvSubmeshRange[] = [{ indexOffset: 0, indexCount: 3, topology: 'triangle-list' }];
    expect(computeUvSegments(uv, indices, submeshes)).toHaveLength(3);
  });

  it('skips triangles with out-of-range or NaN uv', () => {
    const uv = new Float32Array([0, 0, NaN, 0, 0, 1]);
    const indices = new Uint16Array([0, 1, 2]);
    const submeshes: UvSubmeshRange[] = [{ indexOffset: 0, indexCount: 3, topology: 'triangle-list' }];
    expect(computeUvSegments(uv, indices, submeshes)).toEqual([]);
  });
});

describe('listUvChannels', () => {
  it('lists present UV channels in canonical order', () => {
    const attributes = { uv: new Float32Array([0, 0]), uv2: new Float32Array([0, 0]), uv1: new Float32Array([0, 0]) };
    expect(listUvChannels(attributes)).toEqual(['uv', 'uv1', 'uv2']);
  });

  it('returns empty when attributes is undefined', () => {
    expect(listUvChannels(undefined)).toEqual([]);
  });

  it('skips non-array-like and too-short values', () => {
    const attributes = { uv: 'nope', uv1: 5, uv2: [], uv3: new Float32Array([0]) };
    expect(listUvChannels(attributes)).toEqual([]);
  });

  it('canonical key order covers uv + uv1..uv7', () => {
    expect(UV_CHANNEL_KEYS).toEqual(['uv', 'uv1', 'uv2', 'uv3', 'uv4', 'uv5', 'uv6', 'uv7']);
  });
});

describe('normalizeUv', () => {
  it('wraps out-of-range UVs into [0,1)', () => {
    expect(normalizeUv(1.25)).toBeCloseTo(0.25);
    expect(normalizeUv(-0.25)).toBeCloseTo(0.75);
    expect(normalizeUv(2)).toBeCloseTo(0);
  });

  it('passes in-range UVs through', () => {
    expect(normalizeUv(0)).toBe(0);
    expect(normalizeUv(0.5)).toBeCloseTo(0.5);
  });

  it('maps NaN to 0', () => {
    expect(normalizeUv(NaN)).toBe(0);
  });
});
