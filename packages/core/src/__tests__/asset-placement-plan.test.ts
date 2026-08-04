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

  // Phantom-ref guard (spawn-door catalog validation): every spawnEntity
  // resolution path goes through loadByGuid, so a ref whose GUID is absent
  // from the live catalog (stale Content Browser row — deleted / failed-import
  // source) must be rejected BEFORE any world mutation, not spawn a silent
  // gray entity. The guard fires only when the caller supplies catalogGuids.
  describe('phantom-ref guard (catalogGuids)', () => {
    const meshRef = {
      type: 'asset' as const,
      guid: 'mesh-guid',
      kind: 'mesh',
      name: 'Hero mesh',
      authoring: authoringCapabilityForAssetKind('mesh'),
    };

    it('rejects a ref whose GUID is not in the live catalog (placement-asset-unknown)', () => {
      const plan = planAssetPlacement(meshRef, { catalogGuids: ['other-guid'] });
      expect(plan.ok).toBe(false);
      if (plan.ok) return;
      expect(plan.error.code).toBe('placement-asset-unknown');
      expect(plan.error.hint).toContain('not in the live asset catalog');
    });

    it('rejects a ref carrying an empty GUID', () => {
      const plan = planAssetPlacement({ ...meshRef, guid: '' }, { catalogGuids: ['other-guid'] });
      expect(plan.ok).toBe(false);
      if (plan.ok) return;
      expect(plan.error.code).toBe('placement-asset-unknown');
      expect(plan.error.hint).toContain('no asset GUID');
    });

    it('accepts a catalogued ref, case-insensitively', () => {
      const plan = planAssetPlacement(
        { ...meshRef, guid: 'ABC123' },
        { catalogGuids: ['abc123'] },
      );
      expect(plan.ok).toBe(true);
    });

    it('skips validation entirely when catalogGuids is omitted (registry-less env)', () => {
      const plan = planAssetPlacement(meshRef);
      expect(plan.ok).toBe(true);
    });

    it('does not fire for the scene-mount branch (its own requestId validation stays authoritative)', () => {
      const sceneRef = {
        type: 'asset' as const,
        guid: 'scene-guid',
        kind: 'scene',
        name: 'Hero scene',
        authoring: authoringCapabilityForAssetKind('scene'),
      };
      // Missing requestId still reports placement-input-invalid, NOT
      // placement-asset-unknown — even though 'scene-guid' is absent from
      // catalogGuids (scene GUIDs resolve through the meta-sidecar fallback).
      const plan = planAssetPlacement(sceneRef, { catalogGuids: [] });
      expect(plan).toEqual({
        ok: false,
        error: { code: 'placement-input-invalid', hint: expect.stringContaining('requestId') },
      });
      // And a fully correlated scene plan is unaffected by the guard.
      expect(planAssetPlacement(sceneRef, { requestId: 'r1', catalogGuids: [] }).ok).toBe(true);
    });
  });
});
