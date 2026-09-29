/** Inline ECS-neutral schemas for ScriptablePack scene externalization (no engine-render/scene imports). */
export const SAMPLE_SCENE_COMPONENTS = [
  { name: 'Name', fields: { value: 'string' } },
  {
    name: 'Transform',
    fields: {
      pos: 'array<f32, 3>',
      quat: 'array<f32, 4>',
      scale: 'array<f32, 3>',
      world: 'array<f32, 16>',
    },
  },
  { name: 'MeshFilter', fields: { assetHandle: 'shared<MeshAsset>' } },
  { name: 'MeshRenderer', fields: { materials: 'array<shared<MaterialAsset>>' } },
  { name: 'ChildOf', fields: { parent: 'entity' } },
] as const;

export const SHOWCASE_SCENE_COMPONENTS = [
  ...SAMPLE_SCENE_COMPONENTS,
  {
    name: 'ParticleEffectPlayer',
    fields: {
      effect: 'shared<ParticleEffectAsset>',
      playing: 'bool',
      seed: 'u32',
      timeScale: 'f32',
    },
  },
] as const;
