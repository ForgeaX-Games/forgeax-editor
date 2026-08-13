// Pure helper: given the current DockRegion + panelId + callbacks, return the
// list of tab-context-menu items dockview should render on right-click.
//
// Every user-visible item is emitted as a custom { label, action } entry so its
// text flows through the i18n catalog (dockShell.tabContext.* / dockShell.*) —
// dockview's built-in `close`/`closeOthers` ids render library-hardcoded English
// labels that can't be localized, so we drive the close actions ourselves via
// the dockview panel/group API passed in `closeOptions`.
import type { DockRegion } from './regions';
import { t as panelT } from '../../i18n';
import type { SideEdge } from './sideEdgeMove';

export type TabContextMenuItem =
  | 'close'
  | 'closeOthers'
  | 'closeAll'
  | 'separator'
  | { label: string; action: () => void };

/** Close actions wired to the dockview API (panel.close / close-siblings). */
export interface CloseMenuOptions {
  onClose: () => void;
  onCloseOthers: () => void;
}

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

export interface PopOutMenuOptions {
  onPopOut: () => void;
}

export function buildTabContextMenuItems(
  region: DockRegion,
  panelId: string,
  moveTo: (panelId: string, region: DockRegion) => void,
  titleOptions?: TabTitleMenuOptions,
  sideEdge?: SideEdgeMenuOptions,
  closeOptions?: CloseMenuOptions,
  popOutOptions?: PopOutMenuOptions,
): TabContextMenuItem[] {
  // Close / Close Others as localized custom items (see file header). When no
  // close handlers are supplied (pure-builder tests) fall back to dockview's
  // built-in ids so the item ordering stays observable.
  const items: TabContextMenuItem[] = closeOptions
    ? [
        { label: panelT('dockShell.tabContext.close'), action: closeOptions.onClose },
        { label: panelT('dockShell.tabContext.closeOthers'), action: closeOptions.onCloseOthers },
        'separator',
      ]
    : ['close', 'closeOthers', 'separator'];

  if (popOutOptions) {
    items.unshift(
      {
        label: panelT('dockShell.tabContext.openInNewWindow'),
        action: popOutOptions.onPopOut,
      },
      'separator',
    );
  }

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

  // Title-bar hiding is a primary-dock affordance only: a panel parked on a
  // left/right side strip renders through the collapsed edge chrome, which has
  // no title bar to hide — so suppress the option there (offering it did
  // nothing but confuse). Bottom/AuxBar keep their existing behavior.
  if (titleOptions?.groupPanelCount === 1 && !sideEdge?.onSideEdge) {
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

  // Chat lives in its own ChatDock column by default. Once it has been dragged
  // out into another region, offer a one-click "show in default position" that
  // sends it home. Suppressed while chat is already in ChatDock (nothing to
  // reset), so the item only appears where it does something.
  if (panelId === 'chat' && region !== 'ChatDock') {
    items.push('separator', {
      label: panelT('dockShell.chatToDefault'),
      action: () => moveTo('chat', 'ChatDock'),
    });
  }
  return items;
}
