import { AssetGuid } from '@forgeax/engine-pack/guid';
import { definePackageId, type ScriptablePackDefinition } from '@forgeax/engine-pack/source';
import type { MaterialAsset, MeshAsset, SceneAsset } from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import {
  createShardMesh,
  deriveShardMesh,
  derivedEnergyMaterial,
  material,
  pylonModuleScene,
  warningMaterial,
  showcaseScene,
  SAMPLE_SCENE_COMPONENTS,
} from './procedural-showcase.pack-lib.ts';

function guid(value: string) {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

export const SHOWCASE_ASSET_IDS = {
  shard: 'b2252b93-d840-532e-8cdd-4682b7648a09',
  platform: '6dbf4829-9770-5222-9df4-ce4fa94035f6',
  energy: '4b072995-5034-5477-90cb-81b8a8f6bb82',
  platformMaterial: 'd658c30f-0267-50f8-a862-37d1ef314438',
  ring: '4b946fb3-3ab1-5158-9c6e-62a0a0a67971',
  warning: '4e1c86ca-6fbe-50a1-9157-b1ea481c111e',
  pylonModule: '3406dad5-c484-5fe0-b241-c5895a054192',
  arena: 'b05d3430-4c47-558d-9201-f2a8e54f8771',
} as const;

const externalAssets = {
  templateShard: guid('3e915dea-1871-5b8d-b182-e4c8d1663194'),
  accentMaterial: guid('b6b811da-3b1e-5087-96c6-d5f835fbddb3'),
  crystalCluster: guid('73f94bbf-1b57-58d1-afbf-023bdaab0b6d'),
  flowTexture: guid('6e6de455-9ff1-4d5c-a896-ff1426531791'),
  flowSampler: guid('263c8135-3f53-4e3d-9038-6c7288afce3f'),
  arcNovaEffect: guid('019f56f2-0ac0-776a-9d28-50eb5a9edeb9'),
} as const;

export default {
  schemaVersion: '2.0.0',
  packageId: definePackageId('019ffdb4-1000-7000-8000-000000000000'),
  name: 'Sample Scriptable Showcase',
  sceneComponents: SAMPLE_SCENE_COMPONENTS,
  async build(reader) {
    const template = await reader.readByGuid<MeshAsset>(externalAssets.templateShard);
    if (!template.ok) return template;
    const accent = await reader.readByGuid<MaterialAsset>(externalAssets.accentMaterial);
    if (!accent.ok) return accent;
    const crystalCluster = await reader.readByGuid<SceneAsset>(externalAssets.crystalCluster);
    if (!crystalCluster.ok) return crystalCluster;
    const clusterSlots = Object.keys(crystalCluster.value.entities).length;
    if (clusterSlots !== 2) {
      return {
        ok: false,
        error: {
          code: 'pack-source-output-invalid',
          expected: 'crystal-cluster to expose two stable slots',
          hint: 'rebuild the primitive input pack before publishing the arena',
          detail: { clusterSlots },
        },
      } as never;
    }
    return ok({
      'mesh/generated-shard': deriveShardMesh(template.value, guid(SHOWCASE_ASSET_IDS.energy)),
      'mesh/platform': createShardMesh(0.7, guid(SHOWCASE_ASSET_IDS.platformMaterial)),
      'mesh/ring': createShardMesh(1.35, guid(SHOWCASE_ASSET_IDS.warning)),
      'material/energy': derivedEnergyMaterial(accent.value),
      'material/platform': material([0.08, 0.12, 0.2, 1], 0.7, 0.32),
      'material/warning': warningMaterial(
        AssetGuid.format(externalAssets.flowTexture),
        AssetGuid.format(externalAssets.flowSampler),
      ),
      'scene/pylon-module': pylonModuleScene({
        pylonGuid: SHOWCASE_ASSET_IDS.platform,
        shardGuid: SHOWCASE_ASSET_IDS.shard,
        platformMaterialGuid: SHOWCASE_ASSET_IDS.platformMaterial,
      }),
      'scene/scriptable-showcase': showcaseScene({
        shardGuid: SHOWCASE_ASSET_IDS.shard,
        platformGuid: SHOWCASE_ASSET_IDS.platform,
        ringGuid: SHOWCASE_ASSET_IDS.ring,
        energyMaterialGuid: SHOWCASE_ASSET_IDS.energy,
        platformMaterialGuid: SHOWCASE_ASSET_IDS.platformMaterial,
        warningMaterialGuid: SHOWCASE_ASSET_IDS.warning,
        accentMaterialGuid: AssetGuid.format(externalAssets.accentMaterial),
        crystalClusterGuid: AssetGuid.format(externalAssets.crystalCluster),
        pylonModuleGuid: SHOWCASE_ASSET_IDS.pylonModule,
        arcNovaEffectGuid: '019f56f2-0ac0-776a-9d28-50eb5a9edeb9',
      }),
    });
  },
} satisfies ScriptablePackDefinition;
