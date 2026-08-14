// mesh-inspection-facts — Details projection from the MeshAsset payload SSOT.
// Lit/Unlit/Wireframe stay engine-owned (per-camera view mode); this module
// only surfaces facts already on MeshAsset: AABB, attributes, submesh topology.

function asFloats(value: unknown): number[] | null {
  if (Array.isArray(value) && value.length >= 6 && value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return value as number[];
  }
  if (value instanceof Float32Array && value.length >= 6) {
    const out = Array.from(value);
    return out.every((n) => Number.isFinite(n)) ? out : null;
  }
  return null;
}

function fmt(n: number, digits = 3): string {
  return n.toFixed(digits);
}

function presentKeys(attributes: Record<string, unknown> | undefined): string[] {
  if (!attributes) return [];
  return Object.keys(attributes).filter((key) => attributes[key] != null);
}

export interface MeshInspectionFacts {
  readonly vertexCount: number | '—';
  readonly triangleCount: number | '—';
  readonly submeshCount: number;
  readonly attributeKeys: readonly string[];
  readonly hasNormals: boolean;
  readonly hasTangents: boolean;
  readonly hasUv: boolean;
  readonly uvSetCount: number;
  readonly aabbMin: string;
  readonly aabbMax: string;
  readonly boundsRadius: string;
  readonly topologies: readonly string[];
}

export function meshInspectionFacts(payload: Record<string, unknown>): MeshInspectionFacts {
  const vertices = payload.vertices;
  const indices = payload.indices;
  const attributes = payload.attributes as Record<string, unknown> | undefined;
  const submeshes = payload.submeshes;
  const attributeKeys = presentKeys(attributes);
  const vertexCount = Array.isArray(vertices) || vertices instanceof Float32Array
    ? Math.floor(vertices.length / 3)
    : '—';
  const triangleCount = Array.isArray(indices) || indices instanceof Uint16Array || indices instanceof Uint32Array
    ? Math.floor(indices.length / 3)
    : '—';
  const submeshList = Array.isArray(submeshes) ? submeshes : [];
  const topologies = [...new Set(
    submeshList
      .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as { topology?: unknown }).topology : undefined))
      .filter((topology): topology is string => typeof topology === 'string' && topology.length > 0),
  )];

  const aabb = asFloats(payload.aabb);
  let aabbMin = '—';
  let aabbMax = '—';
  let boundsRadius = '—';
  if (aabb !== null && aabb[0]! <= aabb[3]! && aabb[1]! <= aabb[4]! && aabb[2]! <= aabb[5]!) {
    aabbMin = `${fmt(aabb[0]!)}, ${fmt(aabb[1]!)}, ${fmt(aabb[2]!)}`;
    aabbMax = `${fmt(aabb[3]!)}, ${fmt(aabb[4]!)}, ${fmt(aabb[5]!)}`;
    const halfX = (aabb[3]! - aabb[0]!) / 2;
    const halfY = (aabb[4]! - aabb[1]!) / 2;
    const halfZ = (aabb[5]! - aabb[2]!) / 2;
    boundsRadius = fmt(Math.max(0, Math.hypot(halfX, halfY, halfZ)));
  }

  const hasUv = attributeKeys.some((key) => key === 'uv' || /^uv\d+$/.test(key));
  const uvSetCount = attributeKeys.filter((key) => key === 'uv' || /^uv\d+$/.test(key)).length;

  return {
    vertexCount,
    triangleCount,
    submeshCount: submeshList.length,
    attributeKeys,
    hasNormals: attributeKeys.includes('normal'),
    hasTangents: attributeKeys.includes('tangent'),
    hasUv,
    uvSetCount,
    aabbMin,
    aabbMax,
    boundsRadius,
    topologies,
  };
}
