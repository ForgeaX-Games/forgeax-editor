// material-toolbar — the Material properties panel's parameter search, lifted
// into the panel header's action row as a self-registered `control`.
//
// Ownership: the search field is INTERNAL to the material inspector feature.
// Its text lives in the module-private store below (both the header control and
// AssetPreviewMaterial's row filtering read it); AssetPreviewMaterial registers
// the control against its own `asset-properties` panel through `useHost()` while
// mounted. The three flat buttons next to it (Save / Expand All / Collapse All)
// are plain command actions declared in asset-editors-contributions — supported
// declaratively, so they need no control.

import { useEffect, useSyncExternalStore, type ReactElement } from 'react';
import { useHost } from '@forgeax/interface/core/app-shell';
import { ForgeaxIcon } from '@forgeax/editor-ui';
import './material-toolbar.css';

let filterText = '';
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function getMaterialFilter(): string {
  return filterText;
}

export function setMaterialFilter(next: string): void {
  if (next === filterText) return;
  filterText = next;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The material parameter filter text, shared between the header search control
 *  and AssetPreviewMaterial's row filtering. */
export function useMaterialFilter(): string {
  return useSyncExternalStore(subscribe, () => filterText, () => filterText);
}

function MaterialSearchControl(): ReactElement {
  const value = useMaterialFilter();
  return (
    <div className="fx-matbar-search">
      <span className="mag"><ForgeaxIcon name="search" size={13} /></span>
      <input
        type="text"
        placeholder="Search parameters…"
        value={value}
        data-testid="mat-search"
        onChange={(e) => setMaterialFilter(e.target.value)}
      />
    </div>
  );
}

/**
 * Registers the material parameter search as a `control` on the
 * `asset-properties` header (to the right of the flat Save / Expand / Collapse
 * command buttons) for as long as the material inspector is mounted.
 */
export function useMaterialToolbarRegistration(): void {
  const host = useHost();
  useEffect(() => {
    const owner = 'asset-properties:material-search';
    const offControls = host.panelControls.contribute(owner, [
      { id: 'material.search', render: () => <MaterialSearchControl /> },
    ]);
    const offActions = host.panelActions.contribute(owner, [
      {
        // Center zone is the only header zone that grows, so the search sits
        // here and its CSS stretches it to fill the space left of the (empty)
        // right zone — the three flat command buttons stay pinned on the left.
        kind: 'control',
        id: 'material.search.action',
        panelId: 'asset-properties',
        control: 'material.search',
        location: 'header/center',
        order: 10,
      },
    ]);
    return () => {
      offControls();
      offActions();
      setMaterialFilter('');
    };
  }, [host]);
}
