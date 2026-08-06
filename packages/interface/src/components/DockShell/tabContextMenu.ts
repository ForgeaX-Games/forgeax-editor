// Pure helper: given the current DockRegion + panelId + callbacks, return the
// list of tab-context-menu items dockview should render on right-click.
//
// The list is a mix of built-in item ids (dockview handles close / closeOthers)
// and custom { label, action } items. dockview's own type for these is
// `(BuiltInContextMenuItem | ReactContextMenuItemConfig)[]`; we express the
// custom item shape structurally so we don't depend on dockview types beyond
// what we produce.
import type { DockRegion } from './regions';
import { t as panelT } from '../../i18n';
import type { SideEdge } from './sideEdgeMove';

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

/** DockShell side-strip move (left/right edge groups). Replaces Aux Bar move. */
export interface SideEdgeMenuOptions {
  onSideEdge: boolean;
  nearerSide: SideEdge;
  onMoveToSide: (side: SideEdge) => void;
  onMoveOffSide: () => void;
}

export function buildTabContextMenuItems(
  region: DockRegion,
  panelId: string,
  moveTo: (panelId: string, region: DockRegion) => void,
  titleOptions?: TabTitleMenuOptions,
  sideEdge?: SideEdgeMenuOptions,
): TabContextMenuItem[] {
  const items: TabContextMenuItem[] = [
    'close',
    'closeOthers',
    'separator',
  ];

  if (region === 'AuxBar') {
    // AuxBar is a separate DockviewReact instance — side-edge move lives in
    // DockShell only. Keep a way back to the primary dock.
    items.push({
      label: panelT('dockShell.moveToPrimaryDock'),
      action: () => moveTo(panelId, 'DockShell'),
    });
  } else if (sideEdge) {
    if (sideEdge.onSideEdge) {
      items.push({
        label: panelT('dockShell.moveOffSide'),
        action: () => sideEdge.onMoveOffSide(),
      });
    } else {
      items.push({
        label: panelT('dockShell.moveToSide'),
        action: () => sideEdge.onMoveToSide(sideEdge.nearerSide),
      });
    }
  }

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
