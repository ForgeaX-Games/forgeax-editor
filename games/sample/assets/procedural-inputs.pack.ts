import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { ScriptablePackDefinition } from '@forgeax/engine-pack/source';
import type { SceneAsset } from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import { createShardMesh, material } from './procedural-showcase.pack-lib.ts';

function guid(value: string) {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

export const INPUT_ASSET_IDS = {
  'mesh/template-shard': { guid: guid('019ffdb4-0000-7000-8000-000000000001'), kind: 'mesh', name: 'Scriptable Input / Template Shard' },
  'material/accent': { guid: guid('019ffdb4-0000-7000-8000-000000000002'), kind: 'material', name: 'Scriptable Input / Accent' },
  'mesh/pylon': { guid: guid('019ffdb4-0000-7000-8000-000000000003'), kind: 'mesh', name: 'Scriptable Input / Pylon' },
  'scene/crystal-cluster': { guid: guid('019ffdb4-0000-7000-8000-000000000004'), kind: 'scene', name: 'Scriptable Input / Crystal Cluster' },
} as const;

const assets = INPUT_ASSET_IDS;

const CRYSTAL_CLUSTER: SceneAsset = {
  kind: 'scene',
  entities: [
    {
      localId: 0 as never,
      components: {
        Name: { value: 'Crystal Cluster Root' },
        Transform: { pos: [0, 0.4, 0], quat: [0, 0, 0, 1], scale: [1.2, 1.2, 1.2] },
        MeshFilter: { assetHandle: '019ffdb4-0000-7000-8000-000000000003' },
        MeshRenderer: { materials: ['019ffdb4-0000-7000-8000-000000000002'] },
      },
    },
    {
      localId: 1 as never,
      components: {
        Name: { value: 'Crystal Cluster Child' },
        Transform: { pos: [0.55, 0.2, 0], quat: [0, 0, 0, 1], scale: [0.65, 0.65, 0.65] },
        ChildOf: { parent: 0 },
        MeshFilter: { assetHandle: '019ffdb4-0000-7000-8000-000000000001' },
        MeshRenderer: { materials: ['019ffdb4-0000-7000-8000-000000000002'] },
      },
    },
  ],
};

export default {
  schemaVersion: '1.0.0',
  packageId: guid('019ffdb4-0000-7000-8000-000000000000'),
  name: 'Sample Scriptable Inputs',
  assets,
  externalAssets: {},
  build: () => ok({
    'mesh/template-shard': createShardMesh(1),
    'material/accent': material([0.48, 0.22, 0.95, 1], 0.25, 0.28),
    'mesh/pylon': createShardMesh(0.62, '019ffdb4-0000-7000-8000-000000000002'),
    'scene/crystal-cluster': CRYSTAL_CLUSTER,
  }),
} satisfies ScriptablePackDefinition<typeof assets>;
