// Pure helper: given the current DockRegion + panelId + a moveTo callback,
// return the list of tab-context-menu items dockview should render on right-click.
//
// The list is a mix of built-in item ids (dockview handles close / closeOthers)
// and custom { label, action } items. dockview's own type for these is
// `(BuiltInContextMenuItem | ReactContextMenuItemConfig)[]`; we express the
// custom item shape structurally so we don't depend on dockview types beyond
// what we produce.
import type { DockRegion } from './regions';

export type TabContextMenuItem =
  | 'close'
  | 'closeOthers'
  | 'closeAll'
  | 'separator'
  | { label: string; action: () => void };

export function buildTabContextMenuItems(
  region: DockRegion,
  panelId: string,
  moveTo: (panelId: string, region: DockRegion) => void,
): TabContextMenuItem[] {
  const otherRegion: DockRegion = region === 'DockShell' ? 'AuxBar' : 'DockShell';
  const label = region === 'DockShell' ? 'Move to Aux Bar' : 'Move to Primary Dock';
  return [
    'close',
    'closeOthers',
    'separator',
    { label, action: () => moveTo(panelId, otherRegion) },
  ];
}
