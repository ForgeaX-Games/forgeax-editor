import { describe, expect, it } from 'bun:test';
import { meshInspectionFacts } from '../asset-inspector/mesh-inspection-facts';

describe('meshInspectionFacts', () => {
  it('projects AABB, UV/tangent presence, and submesh topology from MeshAsset payload', () => {
    const facts = meshInspectionFacts({
      vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      attributes: { position: [0], normal: [0], uv: [0], tangent: [0], uv1: [0] },
      aabb: [-1, -2, -3, 1, 2, 3],
      submeshes: [
        { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' },
      ],
    });
    expect(facts.vertexCount).toBe(3);
    expect(facts.triangleCount).toBe(1);
    expect(facts.submeshCount).toBe(1);
    expect(facts.hasNormals).toBe(true);
    expect(facts.hasTangents).toBe(true);
    expect(facts.hasUv).toBe(true);
    expect(facts.uvSetCount).toBe(2);
    expect(facts.aabbMin).toBe('-1.000, -2.000, -3.000');
    expect(facts.aabbMax).toBe('1.000, 2.000, 3.000');
    expect(facts.boundsRadius).toBe('3.742');
    expect(facts.topologies).toEqual(['triangle-list']);
  });

  it('falls back when AABB or attributes are absent', () => {
    const facts = meshInspectionFacts({ vertices: [], submeshes: [] });
    expect(facts.vertexCount).toBe(0);
    expect(facts.aabbMin).toBe('—');
    expect(facts.aabbMax).toBe('—');
    expect(facts.hasNormals).toBe(false);
    expect(facts.hasUv).toBe(false);
    expect(facts.topologies).toEqual([]);
  });
});
