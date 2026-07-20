// packages/interface/src/components/DockShell/resolveRegion.ts
//
// Pure resolver for panel → region membership. Extracted from useLayoutStore.ts
// (T6, retired): the store is gone, but the resolver stays — DockRegion now
// reads overrides from the active workbench via useActiveWorkbench().
import type { DockRegion } from './regions';

/** Minimal shape of PanelDescriptor needed by `resolveRegion`. The full
 *  interface lives in panelRenderers.ts and picks this field up implicitly. */
export interface PanelDescriptorLite {
  defaultRegion?: DockRegion;
}

/** Resolve which region a panel currently lives in.
 *  Precedence: override > descriptor.defaultRegion > 'DockShell'. */
export function resolveRegion(
  id: string,
  descriptor: PanelDescriptorLite,
  overrides: Record<string, DockRegion>,
): DockRegion {
  return overrides[id] ?? descriptor.defaultRegion ?? 'DockShell';
}
