// Pure helper: given the current DockRegion + panelId + a moveTo callback,
// return the list of tab-context-menu items dockview should render on right-click.
//
// The list is a mix of built-in item ids (dockview handles close / closeOthers)
// and custom { label, action } items. dockview's own type for these is
// `(BuiltInContextMenuItem | ReactContextMenuItemConfig)[]`; we express the
// custom item shape structurally so we don't depend on dockview types beyond
// what we produce.
import type { DockRegion } from './regions';
import { t as panelT } from '../../i18n';

export type TabContextMenuItem =
  | 'close'
  | 'closeOthers'
  | 'closeAll'
  | 'separator'
  | { label: string; action: () => void };

export interface TabTitleMenuOptions {
  /** Title-bar hiding is only valid while this group contains one panel. */
  groupPanelCount?: number;
  titleHidden?: boolean;
  onHideTitle?: () => void;
  onShowTitle?: () => void;
}

export function buildTabContextMenuItems(
  region: DockRegion,
  panelId: string,
  moveTo: (panelId: string, region: DockRegion) => void,
  titleOptions?: TabTitleMenuOptions,
): TabContextMenuItem[] {
  const otherRegion: DockRegion = region === 'DockShell' ? 'AuxBar' : 'DockShell';
  const label = region === 'DockShell' ? 'Move to Aux Bar' : 'Move to Primary Dock';
  const items: TabContextMenuItem[] = [
    'close',
    'closeOthers',
    'separator',
    { label, action: () => moveTo(panelId, otherRegion) },
  ];
  if (titleOptions?.groupPanelCount === 1) {
    const titleHidden = titleOptions.titleHidden === true;
    const action = titleHidden ? titleOptions.onShowTitle : titleOptions.onHideTitle;
    if (action) {
      items.push(
        'separator',
        {
          label: titleHidden
            ? panelT('dockShell.showPanelTitle')
            : panelT('dockShell.hidePanelTitle'),
          action,
        },
      );
    }
  }
  return items;
}
