import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';

const FORWARD_PASSES = [
  {
    name: 'Forward',
    program: { module: 'forgeax::default-standard-pbr' },
    renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
  },
  {
    name: 'ShadowCaster',
    program: { module: 'forgeax::default-shadow-caster' },
    renderState: { tags: { LightMode: 'ShadowCaster' }, passKind: 'shadow-caster' },
  },
] as const;

const STANDARD_PARAMETERS = [
  { name: 'baseColor', type: 'color' },
  { name: 'metallic', type: 'f32' },
  { name: 'roughness', type: 'f32' },
] as const;

/** Minimal shard mesh for the inputs ScriptablePack (keeps worker init lightweight). */
export function createShardMesh(scale = 1, defaultMaterial?: string): MeshAsset {
  const vertices = new Float32Array([
    0, 0.9 * scale, 0, 0, 1, 0, 0.5, 1, 1, 0, 0, 1,
    0, -0.7 * scale, 0, 0, -1, 0, 0.5, 0, 1, 0, 0, 1,
    0.3 * scale, 0, 0, 1, 0, 0, 1, 0.5, 0, 0, -1, 1,
    -0.3 * scale, 0, 0, -1, 0, 0, 0, 0.5, 0, 0, 1, 1,
    0, 0, 0.3 * scale, 0, 0, 1, 0.5, 0.5, 1, 0, 0, 1,
    0, 0, -0.3 * scale, 0, 0, -1, 0.5, 0.5, -1, 0, 0, 1,
  ]);
  return {
    kind: 'mesh',
    vertices,
    indices: new Uint16Array([0, 2, 4, 0, 5, 2, 0, 3, 5, 0, 4, 3, 1, 4, 2, 1, 2, 5, 1, 5, 3, 1, 3, 4]),
    attributes: { position: vertices },
    aabb: new Float32Array([-0.3 * scale, -0.7 * scale, -0.3 * scale, 0.3 * scale, 0.9 * scale, 0.3 * scale]),
    submeshes: [{ indexOffset: 0, indexCount: 24, vertexCount: 6, topology: 'triangle-list', materialSlot: 0 }],
    materialSlots: [{ slotName: 'Energy', ...(defaultMaterial === undefined ? {} : { defaultMaterial: defaultMaterial as never }) }],
  };
}

export function material(baseColor: readonly [number, number, number, number], metallic: number, roughness: number): MaterialAsset {
  return {
    kind: 'material',
    passes: FORWARD_PASSES,
    parameters: STANDARD_PARAMETERS,
    values: { baseColor: [...baseColor], metallic, roughness },
  };
}
