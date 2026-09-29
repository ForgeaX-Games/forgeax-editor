import { describe, expect, it } from 'bun:test';
import type { DragAssetRef } from '@forgeax/editor-core';
import { dropClassForVerdict, resolveAssetDropVerdict } from '../asset-ref-drop';

const textureDrag: DragAssetRef = {
  type: 'asset',
  guid: 'tex-1',
  kind: 'texture',
  name: 'sand.jpg',
  payload: {},
};

const meshDrag: DragAssetRef = {
  type: 'asset',
  guid: 'mesh-1',
  kind: 'mesh',
  name: 'cube',
  payload: {},
};

describe('asset-ref-drop', () => {
  it('maps verdicts to drop classes', () => {
    expect(dropClassForVerdict('accept')).toBe('drop-hot');
    expect(dropClassForVerdict('reject')).toBe('drop-reject');
    expect(dropClassForVerdict('none')).toBe('');
  });

  it('accepts texture kinds for texture slots', () => {
    const kinds = new Set(['texture', 'image']);
    expect(resolveAssetDropVerdict('TextureAsset', textureDrag, kinds)).toBe('accept');
    expect(resolveAssetDropVerdict('TextureAsset', meshDrag, kinds)).toBe('reject');
    expect(resolveAssetDropVerdict('TextureAsset', null, kinds)).toBe('none');
  });
});
