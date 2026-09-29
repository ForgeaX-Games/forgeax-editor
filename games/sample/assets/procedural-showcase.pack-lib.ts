import { AssetGuid } from '@forgeax/engine-pack/guid';
import type {
  AssetGuid as AssetGuidType,
  MaterialAsset,
  MeshAsset,
  SceneAsset,
  SceneEntity,
} from '@forgeax/engine-types';

function assetGuid(value: string | AssetGuidType): AssetGuidType {
  if (typeof value !== 'string') return value;
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

/** Shared component schemas used by both sample ScriptablePack scene outputs. */
export const SAMPLE_SCENE_COMPONENTS = [
  { name: 'ChildOf', fields: { parent: 'entity' } },
  { name: 'MeshFilter', fields: { assetHandle: 'shared<MeshAsset>' } },
  { name: 'MeshRenderer', fields: { materials: 'array<shared<MaterialAsset>>' } },
  { name: 'Name', fields: { value: 'string' } },
  {
    name: 'ParticleEffectPlayer',
    fields: {
      effect: 'shared<ParticleEffectAsset>',
      playing: 'bool',
      seed: 'u32',
      timeScale: 'f32',
    },
  },
  {
    name: 'Transform',
    fields: {
      pos: 'array<f32, 3>',
      quat: 'array<f32, 4>',
      scale: 'array<f32, 3>',
    },
  },
] as const;

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

const FLOATS_PER_VERTEX = 12;

/** Decode the sample's position/normal/uv/tangent interleaved buffer. */
function attributesFromInterleaved(vertices: Float32Array): MeshAsset['attributes'] {
  if (vertices.length % FLOATS_PER_VERTEX !== 0) {
    throw new RangeError(`shard vertices must use the ${FLOATS_PER_VERTEX}-float layout`);
  }
  const vertexCount = vertices.length / FLOATS_PER_VERTEX;
  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const tangent = new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const source = vertex * FLOATS_PER_VERTEX;
    position.set(vertices.subarray(source, source + 3), vertex * 3);
    normal.set(vertices.subarray(source + 3, source + 6), vertex * 3);
    uv.set(vertices.subarray(source + 6, source + 8), vertex * 2);
    tangent.set(vertices.subarray(source + 8, source + FLOATS_PER_VERTEX), vertex * 4);
  }
  return { position, normal, uv, tangent };
}

export function createShardMesh(scale = 1, defaultMaterial?: string | AssetGuidType): MeshAsset {
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
    attributes: attributesFromInterleaved(vertices),
    aabb: new Float32Array([-0.3 * scale, -0.7 * scale, -0.3 * scale, 0.3 * scale, 0.9 * scale, 0.3 * scale]),
    submeshes: [{ indexOffset: 0, indexCount: 24, vertexCount: 6, topology: 'triangle-list', materialSlot: 0 }],
    materialSlots: [{ slotName: 'Energy', ...(defaultMaterial === undefined ? {} : { defaultMaterial: assetGuid(defaultMaterial) }) }],
  };
}

export function deriveShardMesh(template: MeshAsset, defaultMaterial: string | AssetGuidType): MeshAsset {
  const vertices = new Float32Array(template.vertices);
  for (let offset = 0; offset < vertices.length; offset += 12) {
    vertices[offset] = (vertices[offset] ?? 0) * 0.72;
    vertices[offset + 1] = (vertices[offset + 1] ?? 0) * 1.35;
    vertices[offset + 2] = (vertices[offset + 2] ?? 0) * 0.72;
  }
  return {
    ...template,
    vertices,
    attributes: attributesFromInterleaved(vertices),
    aabb: new Float32Array([-0.22, -0.95, -0.22, 0.22, 1.22, 0.22]),
    materialSlots: [{ slotName: 'Energy', defaultMaterial: assetGuid(defaultMaterial) }],
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

export function warningMaterial(
  texture: string,
  sampler: string,
): MaterialAsset {
  return {
    kind: 'material',
    passes: FORWARD_PASSES,
    parameters: [...STANDARD_PARAMETERS, { name: 'flowTexture', type: 'texture' }],
    values: {
      baseColor: [0.92, 0.16, 0.42, 1],
      metallic: 0.15,
      roughness: 0.24,
      flowTexture: { texture: texture as never, sampler: sampler as never },
    },
  };
}

export function derivedEnergyMaterial(accent: MaterialAsset): MaterialAsset {
  const inherited = accent.values?.baseColor;
  const baseColor = Array.isArray(inherited) && inherited.length === 4
    ? inherited.map((value, index) => index === 3 ? 1 : Math.min(1, Number(value) * 1.25)) as [number, number, number, number]
    : [0.18, 0.75, 1, 1] as const;
  return material(baseColor, 0.45, 0.18);
}

export function pylonModuleScene(input: {
  readonly pylonGuid: string;
  readonly shardGuid: string;
  readonly platformMaterialGuid: string;
}): SceneAsset {
  return {
    kind: 'scene',
    entities: {
      'entity-0': {
        components: {
          Name: { value: 'Pylon Module Root' },
          Transform: { pos: [0, 0.8, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
          MeshFilter: { assetHandle: input.pylonGuid },
          MeshRenderer: { materials: [input.platformMaterialGuid] },
        },
      },
      'entity-1': {
        components: {
          Name: { value: 'Pylon Module Shard' },
          Transform: { pos: [0, 1.2, 0], quat: [0, 0, 0, 1], scale: [0.55, 0.55, 0.55] },
          ChildOf: { parent: 'entity-0' },
          MeshFilter: { assetHandle: input.shardGuid },
          MeshRenderer: { materials: [input.platformMaterialGuid] },
        },
      },
    },
  };
}

function mountWithTransform(source: string, position: readonly [number, number, number]): SceneEntity {
  return {
    instance: { source },
    components: {
      Name: { value: 'Nested Scene' },
      Transform: { pos: position, quat: [0, 0, 0, 1], scale: [1, 1, 1] },
      ChildOf: { parent: 'entity-0' },
    },
  };
}

export function showcaseScene(input: {
  readonly shardGuid: string;
  readonly platformGuid: string;
  readonly ringGuid: string;
  readonly energyMaterialGuid: string;
  readonly platformMaterialGuid: string;
  readonly warningMaterialGuid: string;
  readonly accentMaterialGuid: string;
  readonly crystalClusterGuid: string;
  readonly pylonModuleGuid: string;
  readonly arcNovaEffectGuid: string;
}): SceneAsset {
  return {
    kind: 'scene',
    entities: {
      'entity-0': {
        components: {
          Name: { value: 'Scriptable Platform' },
          Transform: { pos: [0, 0.15, 0], quat: [0, 0, 0, 1], scale: [5, 0.35, 5] },
          MeshFilter: { assetHandle: input.platformGuid },
          MeshRenderer: { materials: [input.platformMaterialGuid] },
        },
      },
      'entity-1': {
        components: {
          Name: { value: 'Generated Energy Shard' },
          Transform: { pos: [0, 1.4, 0], quat: [0, 0, 0, 1], scale: [1.5, 1.5, 1.5] },
          MeshFilter: { assetHandle: input.shardGuid },
          MeshRenderer: { materials: [input.energyMaterialGuid] },
        },
      },
      'entity-2': {
        components: {
          Name: { value: 'External Accent Witness' },
          Transform: { pos: [2.2, 0.85, 0], quat: [0, 0, 0, 1], scale: [0.8, 0.8, 0.8] },
          MeshFilter: { assetHandle: input.platformGuid },
          MeshRenderer: { materials: [input.accentMaterialGuid] },
        },
      },
      'entity-3': {
        components: {
          Name: { value: 'Resonance Arena Core' },
          Transform: { pos: [0, 1.2, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
          MeshFilter: { assetHandle: input.ringGuid },
          MeshRenderer: { materials: [input.warningMaterialGuid] },
          ParticleEffectPlayer: {
            effect: input.arcNovaEffectGuid,
            playing: true,
            seed: 424242,
            timeScale: 1,
          },
        },
      },

      'instance-4': mountWithTransform(input.crystalClusterGuid, [-3, 0, 0]),
      'instance-7': mountWithTransform(input.crystalClusterGuid, [3, 0, 0]),
      'instance-10': mountWithTransform(input.crystalClusterGuid, [0, 0, -3]),
      'instance-13': mountWithTransform(input.pylonModuleGuid, [-4, 0, -4]),
      'instance-16': mountWithTransform(input.pylonModuleGuid, [0, 0, -4]),
      'instance-19': mountWithTransform(input.pylonModuleGuid, [4, 0, -4]),
      'instance-22': mountWithTransform(input.pylonModuleGuid, [-4, 0, 4]),
      'instance-25': mountWithTransform(input.pylonModuleGuid, [0, 0, 4]),
      'instance-28': mountWithTransform(input.pylonModuleGuid, [4, 0, 4]),
      'instance-31': mountWithTransform(input.pylonModuleGuid, [-4, 0, 0]),
      'instance-34': mountWithTransform(input.pylonModuleGuid, [4, 0, 0]),
    },
  };
}
