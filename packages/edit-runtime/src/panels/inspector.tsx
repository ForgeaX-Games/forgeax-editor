// inspector.tsx — edit-runtime Inspector wrapper (M5 w26).
//
// Wraps the editor-panels InspectorPanel with the Add Component menu
// appended at the bottom. The menu uses engine's getRegisteredComponents()
// registry (component.ts:598) to list all available components grouped
// by mountable (not on entity) vs unmountable (already mounted).
//
// Anchors:
//   requirements AC-12: Inspector "+ Add Component" with grouping
//   research Finding 5: getRegisteredComponents ready, editor first to consume
//   charter F1: single-entry — all component options in one menu

import type { ReactNode } from 'react';
import { InspectorPanel } from '@forgeax/editor-panels';
import { useSelection } from '@forgeax/editor-core';
import { gateway } from '@forgeax/editor-core';
import { entComponents, entExists } from '@forgeax/editor-core';
import { AddComponentMenu } from './add-component-menu';

export function InspectorWithAddComponent(): ReactNode {
  const sel = useSelection();

  // Derive currently-mounted component names from the selected entity.
  // M3 (I1/AC-08): read the component set from the active world (SSOT) via
  // entComponents keyed by EntityHandle. Keys are engine component names.
  const mountedComponents: string[] = [];
  if (sel !== null && entExists(gateway.activeWorld, sel)) {
    for (const key of Object.keys(entComponents(gateway.activeWorld, sel))) {
      mountedComponents.push(key);
    }
  }

  return (
    <div data-testid="inspector-wrapper">
      <InspectorPanel />
      {sel !== null && (
        <AddComponentMenu mountedComponents={mountedComponents} />
      )}
    </div>
  );
}