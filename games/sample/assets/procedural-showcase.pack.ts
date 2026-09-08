import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { ScriptablePackDefinition } from '@forgeax/engine-pack/source';
import type { MaterialAsset, MeshAsset, SamplerAsset, SceneAsset, TextureAsset } from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import {
  createShardMesh,
  deriveShardMesh,
  derivedEnergyMaterial,
  material,
  pylonModuleScene,
  warningMaterial,
  showcaseScene,
} from './procedural-showcase.pack-lib.ts';

function guid(value: string) {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

export const SHOWCASE_ASSET_IDS = {
  shard: '019ffdb4-1000-7000-8000-000000000001',
  platform: '019ffdb4-1000-7000-8000-000000000002',
  energy: '019ffdb4-1000-7000-8000-000000000003',
  platformMaterial: '019ffdb4-1000-7000-8000-000000000004',
  ring: '019ffdb4-1000-7000-8000-000000000005',
  warning: '019ffdb4-1000-7000-8000-000000000006',
  pylonModule: '019ffdb4-1000-7000-8000-000000000007',
  arena: '019ffdb4-1000-7000-8000-000000000008',
} as const;

const assets = {
  'mesh/generated-shard': { guid: guid(SHOWCASE_ASSET_IDS.shard), kind: 'mesh', name: 'Scriptable / Generated Shard' },
  'mesh/platform': { guid: guid(SHOWCASE_ASSET_IDS.platform), kind: 'mesh', name: 'Scriptable / Platform' },
  'mesh/ring': { guid: guid(SHOWCASE_ASSET_IDS.ring), kind: 'mesh', name: 'Scriptable / Arena Ring' },
  'material/energy': { guid: guid(SHOWCASE_ASSET_IDS.energy), kind: 'material', name: 'Scriptable / Energy' },
  'material/platform': { guid: guid(SHOWCASE_ASSET_IDS.platformMaterial), kind: 'material', name: 'Scriptable / Platform' },
  'material/warning': { guid: guid(SHOWCASE_ASSET_IDS.warning), kind: 'material', name: 'Scriptable / Warning Flow' },
  'scene/pylon-module': { guid: guid(SHOWCASE_ASSET_IDS.pylonModule), kind: 'scene', name: 'Pylon Module' },
  'scene/scriptable-showcase': { guid: guid(SHOWCASE_ASSET_IDS.arena), kind: 'scene', name: 'Resonance Arena' },
} as const;

const externalAssets = {
  templateShard: guid('019ffdb4-0000-7000-8000-000000000001'),
  accentMaterial: guid('019ffdb4-0000-7000-8000-000000000002'),
  crystalCluster: guid('019ffdb4-0000-7000-8000-000000000004'),
  flowTexture: guid('6e6de455-9ff1-4d5c-a896-ff1426531791'),
  flowSampler: guid('263c8135-3f53-4e3d-9038-6c7288afce3f'),
  arcNovaEffect: guid('019f56f2-0ac0-776a-9d28-50eb5a9edeb9'),
} as const;

export default {
  schemaVersion: '1.0.0',
  packageId: guid('019ffdb4-1000-7000-8000-000000000000'),
  name: 'Sample Scriptable Showcase',
  assets,
  externalAssets,
  async build(reader) {
    const template = await reader.loadByGuid<MeshAsset>(externalAssets.templateShard);
    if (!template.ok) return template;
    const accent = await reader.loadByGuid<MaterialAsset>(externalAssets.accentMaterial);
    if (!accent.ok) return accent;
    const crystalCluster = await reader.loadByGuid<SceneAsset>(externalAssets.crystalCluster);
    if (!crystalCluster.ok) return crystalCluster;
    const flowTexture = await reader.loadByGuid<TextureAsset>(externalAssets.flowTexture);
    if (!flowTexture.ok) return flowTexture;
    const flowSampler = await reader.loadByGuid<SamplerAsset>(externalAssets.flowSampler);
    if (!flowSampler.ok) return flowSampler;
    const clusterSlots = crystalCluster.value.entities.length + (crystalCluster.value.mounts?.length ?? 0) +
      (crystalCluster.value.mounts?.reduce((total, mount) => total + mount.memberCount, 0) ?? 0);
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
      'mesh/generated-shard': deriveShardMesh(template.value, SHOWCASE_ASSET_IDS.energy),
      'mesh/platform': createShardMesh(0.7, SHOWCASE_ASSET_IDS.platformMaterial),
      'mesh/ring': createShardMesh(1.35, SHOWCASE_ASSET_IDS.warning),
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
} satisfies ScriptablePackDefinition<typeof assets, typeof externalAssets>;
