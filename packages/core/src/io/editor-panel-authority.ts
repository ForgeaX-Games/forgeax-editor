// Editor panel authority — single SSOT for paired read/write routing.
//
// Panels must not independently choose "read from carrier" and "write via
// run.dispatch". The two paths are derived together from one snapshot:
//
//   host-coworker       → read host RuntimeUiGraph / gateway.activeWorld
//                         → write gateway.dispatch
//   projection-client   → read carrier hierarchy.structure (when client ready)
//                         → write run.dispatch (when client ready)
//
// SSOT for product semantics: puckyu-doc/knowledge/domains/hierarchy-viewport-scene-authority.md

import { subscribeDocVersion } from '../store/doc-version';
import { getActiveRuntimeUiGraph } from './runtime-ui-diagnostics';
import { getViewportRuntimeClientSnapshot, subscribeViewportRuntimeClient } from './viewport-runtime-client';

/** How this JS realm participates in the editor data plane. */
export type EditorPanelAuthorityMode = 'host-coworker' | 'projection-client';

export interface EditorPanelAuthoritySnapshot {
  readonly mode: EditorPanelAuthorityMode;
  readonly viewportRuntimeReady: boolean;
  readonly hasLocalRuntimeGraph: boolean;
}

let cachedAuthoritySnapshot: EditorPanelAuthoritySnapshot | null = null;

function readAuthorityFacts(): EditorPanelAuthoritySnapshot {
  const hasLocalRuntimeGraph = getActiveRuntimeUiGraph() !== null;
  const viewportRuntimeReady = getViewportRuntimeClientSnapshot().status === 'ready';
  const mode: EditorPanelAuthorityMode = hasLocalRuntimeGraph ? 'host-coworker' : 'projection-client';
  if (
    cachedAuthoritySnapshot !== null
    && cachedAuthoritySnapshot.mode === mode
    && cachedAuthoritySnapshot.viewportRuntimeReady === viewportRuntimeReady
    && cachedAuthoritySnapshot.hasLocalRuntimeGraph === hasLocalRuntimeGraph
  ) {
    return cachedAuthoritySnapshot;
  }
  cachedAuthoritySnapshot = Object.freeze({ mode, viewportRuntimeReady, hasLocalRuntimeGraph });
  return cachedAuthoritySnapshot;
}

/** Current paired authority facts for panel read models and dispatchActiveEditorOperation. */
export function getEditorPanelAuthoritySnapshot(): EditorPanelAuthoritySnapshot {
  return readAuthorityFacts();
}

/** Subscribe to authority changes (viewport client bind + host graph / doc lifecycle). */
export function subscribeEditorPanelAuthority(listener: () => void): () => void {
  const unsubClient = subscribeViewportRuntimeClient(listener);
  const unsubDoc = subscribeDocVersion(listener);
  return () => {
    unsubClient();
    unsubDoc();
  };
}

/** Write path: mutate the live EditGateway on this host (same World rows read). */
export function usesHostGatewayForPanelDispatch(
  snapshot: EditorPanelAuthoritySnapshot = getEditorPanelAuthoritySnapshot(),
): boolean {
  return snapshot.mode === 'host-coworker';
}

/** Hierarchy structure + row visibility read path: carrier projection cache. */
export function usesCarrierHierarchyProjection(
  snapshot: EditorPanelAuthoritySnapshot = getEditorPanelAuthoritySnapshot(),
): boolean {
  return snapshot.mode === 'projection-client' && snapshot.viewportRuntimeReady;
}

/** Whether document ops may be sent at all from this panel realm. */
export function canDispatchPanelDocumentOperations(
  snapshot: EditorPanelAuthoritySnapshot = getEditorPanelAuthoritySnapshot(),
): boolean {
  if (snapshot.mode === 'host-coworker') return true;
  return snapshot.viewportRuntimeReady;
}
