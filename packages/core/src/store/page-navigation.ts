import { useSyncExternalStore } from 'react';
import type { EditorOp } from '../types';
import { sessionAppliers } from '../io/appliers';
import type { SelectedAsset } from './asset-selection';

export interface EditorPageNavigation {
  openAsset(asset: SelectedAsset): Promise<void>;
  getActiveAsset(): SelectedAsset | null;
  subscribe(listener: () => void): () => void;
}

const inert: EditorPageNavigation = {
  async openAsset() {
    throw new Error('editor Page navigation is not configured by the host');
  },
  getActiveAsset: () => null,
  subscribe: () => () => {},
};

let navigation: EditorPageNavigation = inert;

export function configureEditorPageNavigation(next: EditorPageNavigation | null): () => void {
  navigation = next ?? inert;
  return () => {
    if (navigation === next) navigation = inert;
  };
}

export function getActiveEditorAsset(): SelectedAsset | null {
  return navigation.getActiveAsset();
}

export function useActiveEditorAsset(): SelectedAsset | null {
  return useSyncExternalStore(navigation.subscribe, navigation.getActiveAsset, navigation.getActiveAsset);
}

sessionAppliers.set('openAssetEditor', (op: EditorOp) => {
  const asset = (op as { asset: SelectedAsset }).asset;
  return { ok: true, completion: navigation.openAsset(asset) };
});
