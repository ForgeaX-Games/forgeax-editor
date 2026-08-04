import type { ReactNode } from 'react';
import { useTranslation } from '../../i18n';

const DOCK_TITLE_STATE = 'data-fx-dock-title-state';

type DockGroupElement = HTMLElement & {
  dataset: DOMStringMap & { fxDockTitleState?: 'hidden' | 'visible' };
};

export function setDockTitleHidden(group: HTMLElement, hidden: boolean): void {
  const element = group as DockGroupElement;
  element.dataset.fxDockTitleState = hidden ? 'hidden' : 'visible';
}

/**
 * Resolve the effective title-bar state for a group. An explicit state wins;
 * otherwise a panel's declarative single-tab preference is the default.
 */
export function isDockTitleHidden(group: HTMLElement): boolean {
  const state = group.getAttribute(DOCK_TITLE_STATE);
  if (state === 'hidden') return true;
  if (state === 'visible') return false;
  return group.querySelector('[data-dock-single-tab="hideTitle"]') !== null;
}

function closestDockGroup(target: HTMLElement): HTMLElement | null {
  return target.closest<HTMLElement>('.dv-groupview, .groupview');
}

/** Restore affordance rendered in every dock panel body. CSS only reveals it
 * for a single-panel group whose title bar is currently hidden. */
export function DockTitleRestoreButton(): ReactNode {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="fx-dock-title-restore"
      data-testid="dock-title-restore"
      aria-label={t('dockShell.showPanelTitle')}
      title={t('dockShell.showPanelTitle')}
      onClick={(event) => {
        const group = closestDockGroup(event.currentTarget);
        if (group) setDockTitleHidden(group, false);
      }}
    />
  );
}

/** Keep the restore affordance outside the panel's layout flow. */
export function withDockTitleRestore(render: () => ReactNode): () => ReactNode {
  return () => (
    <>
      {render()}
      <DockTitleRestoreButton />
    </>
  );
}
