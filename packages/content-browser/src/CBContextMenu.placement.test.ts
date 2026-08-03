import { describe, expect, it } from 'bun:test';
import { authoringCapabilityForAssetKind } from '@forgeax/engine-types';
import { buildAssetContextMenu } from './CBContextMenu';
import type { CBAsset, CBSelection } from './types';
import type { EntityHandle } from '@forgeax/editor-core';

function asset(kind: string, authoring = authoringCapabilityForAssetKind(kind)): CBAsset {
  return {
    type: 'asset',
    guid: 'a1111111-1111-4111-8111-111111111111',
    kind,
    name: `${kind}-asset`,
    payload: {},
    packPath: `assets/${kind}.pack.json`,
    packIndex: 0,
    refs: [],
    authoring,
  };
}

function addToSceneItem(target: CBAsset) {
  const selection: CBSelection = { items: [target], primary: target };
  return buildAssetContextMenu(target, selection, [target]).find((item) => item.id === 'add-to-scene');
}

describe('Content Browser placement capability projection', () => {
  it('disables Add to Scene when the producer refuses placement', () => {
    const target = asset('animation-clip');
    expect(addToSceneItem(target)?.disabled).toBe(true);
  });

  it('keeps Add to Scene enabled for a placeable material asset', () => {
    const target = asset('material');
    expect(addToSceneItem(target)?.disabled).toBe(false);
  });

  it('honors an explicit producer refusal over the legacy kind default', () => {
    const target = asset('material', {
      placement: {
        operation: 'unavailable',
        reason: { code: 'missing-producer-capability', hint: 'material provider is read-only' },
      },
      binding: authoringCapabilityForAssetKind('material').binding,
    });
    expect(addToSceneItem(target)?.disabled).toBe(true);
  });

  it('captures the entity before asset selection clears the entity domain', () => {
    const target = asset('mesh');
    const selection: CBSelection = { items: [target], primary: target };
    const assign = buildAssetContextMenu(target, selection, [target], undefined, 42 as EntityHandle)
      .find((item) => item.id === 'assign');
    expect(assign).toBeDefined();
  });
});
