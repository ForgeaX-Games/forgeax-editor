// @forgeax/editor-core — Socket (绑点) data model
//
// A Socket describes a prop's fixed LOCAL transform relative to a skeleton bone.
// Runtime applies: propWorld = boneWorldMatrix × T(position)·R(rotation)·S(scale).
// Because the value is bone-local, it is animation-frame independent and works
// across all clips. See 模型绑点编辑器开发文档.md §5.
//
// This module is pure (no React/IO). zod schemas validate import/export so a
// hand-edited or older `*.socket.json` cannot crash the editor.

import { z } from 'zod';

/** Current on-disk schema version for `*.socket.json`. */
export const SOCKET_DOC_VERSION = 1 as const;

/** Euler rotation order convention for `rotationEulerDegXYZ` (degrees). */
export const SOCKET_EULER_ORDER = 'XYZ' as const;

type Vec3 = [number, number, number];

/** Auxiliary alignment point — visual-only (e.g. off-hand grip). Never drives bones. */
export interface SocketAux {
  id: string;
  bone: string;
  note?: string;
}

/** A single attachment point relative to one bone. */
export interface SocketDef {
  /** Stable id, e.g. "weapon_primary". */
  id: string;
  /** Parent bone name, e.g. "hand_r". */
  bone: string;
  /** Local offset (meters) in bone space. */
  position: Vec3;
  /** Local rotation (degrees, XYZ order) in bone space. */
  rotationEulerDegXYZ: Vec3;
  /** Uniform scalar or per-axis scale. */
  scale: number | Vec3;
  /** Optional hint of which asset this socket is calibrated for. Not used at runtime. */
  assetHint?: string;
  /** Optional auxiliary alignment points (validation only). */
  aux?: SocketAux[];
}

/** A document holding all sockets for one skeleton. */
export interface SocketDoc {
  version: typeof SOCKET_DOC_VERSION;
  /** Skeleton this data was authored against; used to warn on mismatch. */
  skeletonId: string;
  sockets: SocketDef[];
}

// ── zod schemas (used by socket-io for import validation) ──

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

export const SocketAuxSchema: z.ZodType<SocketAux> = z.object({
  id: z.string().min(1),
  bone: z.string().min(1),
  note: z.string().optional(),
});

export const SocketDefSchema: z.ZodType<SocketDef> = z.object({
  id: z.string().min(1),
  bone: z.string().min(1),
  position: Vec3Schema,
  rotationEulerDegXYZ: Vec3Schema,
  scale: z.union([z.number(), Vec3Schema]),
  assetHint: z.string().optional(),
  aux: z.array(SocketAuxSchema).optional(),
});

export const SocketDocSchema: z.ZodType<SocketDoc> = z.object({
  version: z.literal(SOCKET_DOC_VERSION),
  skeletonId: z.string(),
  sockets: z.array(SocketDefSchema),
});

// ── Defaults / factories ──

/** A fresh empty document for a given skeleton. */
export function emptySocketDoc(skeletonId = ''): SocketDoc {
  return { version: SOCKET_DOC_VERSION, skeletonId, sockets: [] };
}

/** A new socket with sane defaults (identity transform, uniform scale 1). */
export function defaultSocket(id: string, bone = ''): SocketDef {
  return {
    id,
    bone,
    position: [0, 0, 0],
    rotationEulerDegXYZ: [0, 0, 0],
    scale: 1,
  };
}

/** Generate an id not already present in `existing` (e.g. "socket", "socket_2", …). */
export function uniqueSocketId(existing: readonly SocketDef[], base = 'socket'): string {
  const taken = new Set(existing.map((s) => s.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ── Conversions ──

/** Normalize scalar-or-vec3 scale to a Vec3 (runtime always wants 3 axes). */
export function normalizeScale(scale: number | Vec3): Vec3 {
  return typeof scale === 'number' ? [scale, scale, scale] : [scale[0], scale[1], scale[2]];
}

/**
 * Convert a desired prop "target size" (meters) into a uniform scale, given the
 * prop model's own largest dimension. Mirrors the POC: scale = target / modelMaxDim.
 * Guards against a zero/NaN model dimension.
 */
export function targetLenToScale(targetMeters: number, modelMaxDim: number): number {
  if (!Number.isFinite(modelMaxDim) || modelMaxDim <= 0) return 1;
  return targetMeters / modelMaxDim;
}

/** Inverse of {@link targetLenToScale}: recover target size (meters) from a uniform scale. */
export function scaleToTargetLen(scale: number, modelMaxDim: number): number {
  if (!Number.isFinite(modelMaxDim) || modelMaxDim <= 0) return scale;
  return scale * modelMaxDim;
}

// ── Lookup helpers ──

export function findSocket(doc: SocketDoc, id: string): SocketDef | undefined {
  return doc.sockets.find((s) => s.id === id);
}
