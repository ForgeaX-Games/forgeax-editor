// packages/interface/src/components/DockShell/regions.ts

/**
 * All named UI regions. Values are used as:
 *   - `data-fx-slot` marker values for the slot debug overlay
 *   - CSS class stems (e.g., `.fx-dockregion-DockShell`)
 *   - localStorage layout key namespaces
 * Add a new region here first; downstream consumers pick it up automatically.
 */
export const REGIONS = ['DockShell', 'AuxBar', 'StatusBar', 'WorkbenchSwitcher'] as const;
export type Region = typeof REGIONS[number];

/**
 * Regions that host movable dock panels. A subset of `Region`. Values that
 * appear in `PanelDescriptor.defaultRegion` and `Workbench.panelLocations`
 * MUST be one of these.
 */
export const DOCK_REGIONS = ['DockShell', 'AuxBar'] as const;
export type DockRegion = typeof DOCK_REGIONS[number];

export function isDockRegion(x: string): x is DockRegion {
  return (DOCK_REGIONS as readonly string[]).includes(x);
}
