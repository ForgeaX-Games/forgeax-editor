import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import type { EntityHandle } from '../scene/scene-types';
import { applierFor } from '../io/appliers';
import { clearAssetSelection, getAssetSelection } from '../store/asset-selection';
import { clearFolderSelection, getFolderSelectionList } from '../store/folder-selection';
import { clearSelection, getSelection } from '../store/selection';

function h(n: number): EntityHandle {
  return n as EntityHandle;
}

function applySession(kind: string, payload: Record<string, unknown>): void {
  const applier = applierFor(kind, 'session');
  if (!applier) throw new Error(`no applier for ${kind}`);
  const result = applier({ kind, ...payload } as never, undefined as never);
  if (!result.ok) throw new Error(`applier ${kind} failed`);
}

const sampleAsset = {
  guid: 'a1111111-1111-4111-8111-111111111111',
  kind: 'mesh',
  name: 'Mesh',
  payload: {},
  packPath: 'assets/mesh.pack.json',
};

describe('orthogonal selection domains — appliers do not cross-clear', () => {
  beforeEach(() => {
    clearSelection();
    clearAssetSelection();
    clearFolderSelection();
  });

  afterAll(() => {
    clearSelection();
    clearAssetSelection();
    clearFolderSelection();
  });

  it('selecting an asset keeps the current entity selection', () => {
    applySession('setSelection', { id: h(42) });
    applySession('setAssetSelectionOne', { asset: sampleAsset });
    expect(getSelection()).toBe(h(42));
    expect(getAssetSelection()?.guid).toBe(sampleAsset.guid);
  });

  it('selecting an entity keeps the current asset selection', () => {
    applySession('setAssetSelectionOne', { asset: sampleAsset });
    applySession('setSelection', { id: h(7) });
    expect(getSelection()).toBe(h(7));
    expect(getAssetSelection()?.guid).toBe(sampleAsset.guid);
  });

  it('selecting a folder path keeps entity and asset selections', () => {
    applySession('setSelection', { id: h(3) });
    applySession('setAssetSelectionOne', { asset: sampleAsset });
    applySession('setFolderSelection', { items: [{ path: 'assets/models', kind: 'dir' }] });
    expect(getSelection()).toBe(h(3));
    expect(getAssetSelection()?.guid).toBe(sampleAsset.guid);
    expect(getFolderSelectionList()).toEqual(['assets/models']);
  });
});
