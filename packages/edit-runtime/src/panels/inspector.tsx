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
import { useSelection } from '@forgeax/editor-shared';
import { bus } from '@forgeax/editor-shared';
import { AddComponentMenu } from './add-component-menu';

export function InspectorWithAddComponent(): ReactNode {
  const sel = useSelection();

  // Derive currently-mounted component names from the selected entity.
  const mountedComponents: string[] = [];
  if (sel !== null) {
    const entity = bus.doc.entities[sel];
    if (entity) {
      for (const key of Object.keys(entity.components)) {
        mountedComponents.push(key);
      }
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