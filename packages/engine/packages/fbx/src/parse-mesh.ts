// parse-mesh.ts — FBX JSON POD to MeshPod bridge (t28).

import type { MeshPod } from '@forgeax/engine-types';

export interface FbxRawMesh {
  readonly name?: string;
  readonly vertices: number[];
  readonly indices?: number[];
  readonly attributes: Record<string, number[]>;
  readonly polygonCount: number;
  readonly sourceIndex: number;
  readonly materialIndex: number;
}

export interface FbxRawDocument {
  readonly meshes?: readonly FbxRawMesh[];
}

export function parseMesh(raw: FbxRawMesh, sourceIndex: number): MeshPod {
  const vertices = new Float32Array(raw.vertices);
  const indices = raw.indices && raw.indices.length > 0 ? new Uint16Array(raw.indices) : undefined;

  const attributes: Record<string, Float32Array | Uint16Array | Uint32Array> = {};
  for (const [key, arr] of Object.entries(raw.attributes)) {
    if (key === 'NORMAL' || key === 'TEXCOORD_0') {
      attributes[key] = new Float32Array(arr);
    } else {
      attributes[key] = new Float32Array(arr);
    }
  }

  const indexCount = indices?.length ?? 0;

  const submeshes = [
    {
      topology: 'triangle-list' as const,
      indexOffset: 0,
      indexCount,
      vertexCount: vertices.length / 3,
      materialIndex: raw.materialIndex >= 0 ? raw.materialIndex : null,
    },
  ];

  return {
    ...(raw.name !== undefined ? { name: raw.name } : {}),
    vertices,
    ...(indices ? { indices } : {}),
    attributes,
    submeshes,
    sourceIndex,
  };
}
