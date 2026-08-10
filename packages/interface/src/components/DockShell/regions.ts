// packages/interface/src/components/DockShell/regions.ts

/**
 * All named UI regions. Values are used as:
 *   - `data-fx-slot` marker values for the slot debug overlay
 *   - CSS class stems (e.g., `.fx-dockregion-DockShell`)
 *   - localStorage layout key namespaces
 * Add a new region here first; downstream consumers pick it up automatically.
 */
export const REGIONS = ['DockShell', 'AuxBar', 'ChatDock', 'StatusBar', 'WorkbenchSwitcher'] as const;
export type Region = typeof REGIONS[number];

/**
 * Regions that host movable dock panels. A subset of `Region`. Values that
 * appear in `PanelDescriptor.defaultRegion` and `Workbench.panelLocations`
 * MUST be one of these.
 *
 * `ChatDock` is a dedicated single-panel dock instance for chat, mounted as a
 * fixed shell column right of the ActivityRail. It is its own DockviewReact
 * instance (like AuxBar) so chat keeps native dock chrome (tab title, context
 * menu, title-hide) while chat can be dragged OUT into DockShell's centre grid
 * via the cross-instance drop path. Foreign panels are refused entry (see the
 * onUnhandledDragOverEvent gate in DockRegion), so only chat lives here.
 */
export const DOCK_REGIONS = ['DockShell', 'AuxBar', 'ChatDock'] as const;
export type DockRegion = typeof DOCK_REGIONS[number];

export function isDockRegion(x: string): x is DockRegion {
  return (DOCK_REGIONS as readonly string[]).includes(x);
}
