/**
 * Hierarchy panel entry: subscribe to the core authority snapshot and expose
 * paired read flags. UI must use this hook — do not re-derive carrier vs host
 * reads from viewportRuntimeReady / getActiveRuntimeUiGraph separately.
 */
import { useMemo, useSyncExternalStore } from 'react';
import {
  getEditorPanelAuthoritySnapshot,
  subscribeEditorPanelAuthority,
  usesCarrierHierarchyProjection,
  type EditorPanelAuthoritySnapshot,
} from '@forgeax/editor-core';
import { resolveHierarchyRuntimeAccess, type HierarchyRuntimeAccess } from './hierarchy-state';

export type { EditorPanelAuthoritySnapshot } from '@forgeax/editor-core';

export function useEditorPanelAuthoritySnapshot(): EditorPanelAuthoritySnapshot {
  return useSyncExternalStore(
    subscribeEditorPanelAuthority,
    getEditorPanelAuthoritySnapshot,
    getEditorPanelAuthoritySnapshot,
  );
}

export interface HierarchyPanelAuthority extends HierarchyRuntimeAccess {
  readonly authority: EditorPanelAuthoritySnapshot;
  /** Alias of hierarchyReadsFromCarrier — single boolean for Row props. */
  readonly readsFromCarrier: boolean;
}

export function useHierarchyPanelAuthority(gatewayMode: 'edit' | 'play'): HierarchyPanelAuthority {
  const authority = useEditorPanelAuthoritySnapshot();
  return useMemo(() => {
    const access = resolveHierarchyRuntimeAccess({ gatewayMode });
    return {
      ...access,
      authority,
      readsFromCarrier: usesCarrierHierarchyProjection(authority),
    };
  }, [authority, gatewayMode]);
}
