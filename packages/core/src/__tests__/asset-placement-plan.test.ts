import { describe, expect, it } from 'bun:test';
import { authoringCapabilityForAssetKind } from '@forgeax/engine-types';
import { planAssetPlacement } from '../assets/asset-placement-plan';

describe('producer-driven asset placement plan', () => {
  it('returns the exact Gateway args for a scene mount and requires correlation', () => {
    const ref = {
      type: 'asset' as const,
      guid: 'scene-guid',
      kind: 'scene',
      name: 'Hero scene',
      authoring: authoringCapabilityForAssetKind('scene'),
    };

    expect(planAssetPlacement(ref)).toEqual({
      ok: false,
      error: { code: 'placement-input-invalid', hint: expect.stringContaining('requestId') },
    });
    expect(planAssetPlacement(ref, { requestId: 'scene-request' })).toMatchObject({
      ok: true,
      plan: {
        operation: 'addSceneAssetToScene',
        args: {
          kind: 'addSceneAssetToScene',
          sceneGuid: 'scene-guid',
          name: 'Hero scene',
          requestId: 'scene-request',
        },
      },
    });
  });

  it('builds spawnEntity args from the producer capability without a consumer kind switch', () => {
    const plan = planAssetPlacement({
      type: 'asset',
      guid: 'mesh-guid',
      kind: 'mesh',
      name: 'Hero mesh',
      authoring: authoringCapabilityForAssetKind('mesh'),
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.plan.operation !== 'spawnEntity') return;
    expect(plan.plan.args.kind).toBe('spawnEntity');
    expect(plan.plan.args.name).toBe('Hero_mesh');
    expect(plan.plan.args.components).toMatchObject({
      Transform: { pos: [0, 0.5, 0] },
      MeshFilter: { assetHandle: 0 },
      EditorPendingMeshAsset: { guid: 'mesh-guid' },
    });
  });

  it('honors an explicit producer refusal even when a legacy kind would otherwise place', () => {
    const plan = planAssetPlacement({
      type: 'asset',
      guid: 'mesh-guid',
      kind: 'mesh',
      authoring: {
        placement: {
          operation: 'unavailable',
          reason: { code: 'missing-producer-capability', hint: 'producer is not ready' },
        },
        binding: authoringCapabilityForAssetKind('mesh').binding,
      },
    });

    expect(plan).toEqual({
      ok: false,
      error: { code: 'placement-unavailable', hint: 'producer is not ready' },
    });
  });
});
