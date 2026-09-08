import type {
  MaterialAsset,
  MeshAsset,
  SceneAsset,
  SceneInstanceMount,
} from '@forgeax/engine-types';

export function sceneMount(
  source: string,
  localId: number,
  memberFirst: number,
  memberCount: number,
  parent = 0,
): SceneInstanceMount {
  if (!Number.isInteger(localId) || localId < 0) throw new RangeError('mount localId must be a non-negative integer');
  if (!Number.isInteger(memberFirst) || memberFirst < 0) throw new RangeError('mount memberFirst must be a non-negative integer');
  if (!Number.isInteger(memberCount) || memberCount <= 0) throw new RangeError('mount memberCount must be positive');
  if (!Number.isInteger(parent) || parent < 0) throw new RangeError('mount parent must be a non-negative integer');
  return {
    localId: localId as never,
    source,
    memberFirst: memberFirst as never,
    memberCount,
    parent: parent as never,
  };
}

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

export function deriveShardMesh(template: MeshAsset, defaultMaterial: string): MeshAsset {
  const vertices = new Float32Array(template.vertices);
  for (let offset = 0; offset < vertices.length; offset += 12) {
    vertices[offset] = (vertices[offset] ?? 0) * 0.72;
    vertices[offset + 1] = (vertices[offset + 1] ?? 0) * 1.35;
    vertices[offset + 2] = (vertices[offset + 2] ?? 0) * 0.72;
  }
  return {
    ...template,
    vertices,
    attributes: { ...template.attributes, position: vertices },
    aabb: new Float32Array([-0.22, -0.95, -0.22, 0.22, 1.22, 0.22]),
    materialSlots: [{ slotName: 'Energy', defaultMaterial: defaultMaterial as never }],
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

export const SHOWCASE_MOUNT_SLOTS = {
  crystalCluster: 2,
  pylonModule: 2,
} as const;

export function pylonModuleScene(input: {
  readonly pylonGuid: string;
  readonly shardGuid: string;
  readonly platformMaterialGuid: string;
}): SceneAsset {
  return {
    kind: 'scene',
    entities: [
      {
        localId: 0 as never,
        components: {
          Name: { value: 'Pylon Module Root' },
          Transform: { pos: [0, 0.8, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
          MeshFilter: { assetHandle: input.pylonGuid },
          MeshRenderer: { materials: [input.platformMaterialGuid] },
        },
      },
      {
        localId: 1 as never,
        components: {
          Name: { value: 'Pylon Module Shard' },
          Transform: { pos: [0, 1.2, 0], quat: [0, 0, 0, 1], scale: [0.55, 0.55, 0.55] },
          ChildOf: { parent: 0 },
          MeshFilter: { assetHandle: input.shardGuid },
          MeshRenderer: { materials: [input.platformMaterialGuid] },
        },
      },
    ],
  };
}

function mountWithTransform(
  source: string,
  localId: number,
  memberFirst: number,
  memberCount: number,
  position: readonly [number, number, number],
): SceneInstanceMount {
  return {
    ...sceneMount(source, localId, memberFirst, memberCount),
    components: {
      Name: { value: `Nested ${source} ${localId}` },
      Transform: { pos: position, quat: [0, 0, 0, 1], scale: [1, 1, 1] },
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
    entities: [
      {
        localId: 0 as never,
        components: {
          Name: { value: 'Scriptable Platform' },
          Transform: { pos: [0, 0.15, 0], quat: [0, 0, 0, 1], scale: [5, 0.35, 5] },
          MeshFilter: { assetHandle: input.platformGuid },
          MeshRenderer: { materials: [input.platformMaterialGuid] },
        },
      },
      {
        localId: 1 as never,
        components: {
          Name: { value: 'Generated Energy Shard' },
          Transform: { pos: [0, 1.4, 0], quat: [0, 0, 0, 1], scale: [1.5, 1.5, 1.5] },
          MeshFilter: { assetHandle: input.shardGuid },
          MeshRenderer: { materials: [input.energyMaterialGuid] },
        },
      },
      {
        localId: 2 as never,
        components: {
          Name: { value: 'External Accent Witness' },
          Transform: { pos: [2.2, 0.85, 0], quat: [0, 0, 0, 1], scale: [0.8, 0.8, 0.8] },
          MeshFilter: { assetHandle: input.platformGuid },
          MeshRenderer: { materials: [input.accentMaterialGuid] },
        },
      },
      {
        localId: 3 as never,
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
    ],
    mounts: [
      mountWithTransform(input.crystalClusterGuid, 4, 5, SHOWCASE_MOUNT_SLOTS.crystalCluster, [-3, 0, 0]),
      mountWithTransform(input.crystalClusterGuid, 7, 8, SHOWCASE_MOUNT_SLOTS.crystalCluster, [3, 0, 0]),
      mountWithTransform(input.crystalClusterGuid, 10, 11, SHOWCASE_MOUNT_SLOTS.crystalCluster, [0, 0, -3]),
      mountWithTransform(input.pylonModuleGuid, 13, 14, SHOWCASE_MOUNT_SLOTS.pylonModule, [-4, 0, -4]),
      mountWithTransform(input.pylonModuleGuid, 16, 17, SHOWCASE_MOUNT_SLOTS.pylonModule, [0, 0, -4]),
      mountWithTransform(input.pylonModuleGuid, 19, 20, SHOWCASE_MOUNT_SLOTS.pylonModule, [4, 0, -4]),
      mountWithTransform(input.pylonModuleGuid, 22, 23, SHOWCASE_MOUNT_SLOTS.pylonModule, [-4, 0, 4]),
      mountWithTransform(input.pylonModuleGuid, 25, 26, SHOWCASE_MOUNT_SLOTS.pylonModule, [0, 0, 4]),
      mountWithTransform(input.pylonModuleGuid, 28, 29, SHOWCASE_MOUNT_SLOTS.pylonModule, [4, 0, 4]),
      mountWithTransform(input.pylonModuleGuid, 31, 32, SHOWCASE_MOUNT_SLOTS.pylonModule, [-4, 0, 0]),
      mountWithTransform(input.pylonModuleGuid, 34, 35, SHOWCASE_MOUNT_SLOTS.pylonModule, [4, 0, 0]),
    ],
  };
}
