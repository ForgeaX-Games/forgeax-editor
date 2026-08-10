// ViewportViewMenu — UE-style view-preset picker anchored to the viewport's
// top-left corner (the "Perspective" label in UE). Shows the current view
// identity (derived from the camera pose — see deriveActiveView) and switches
// view presets through the ONE gateway door: the menu, the Alt+G/H/J/K
// shortcuts, and an AI `gateway.dispatch({kind:'cameraSetView'})` are the same
// session op (north-star single entry).
//
// The label reads the viewport-preferences store SSOT (activeView is mirrored
// in by the viewport's persistViewportState on every camera pose change), so
// the label tracks ANY camera movement path — menu, shortcut, AI op, or a
// gesture-end cameraOrbit — without this component knowing about viewports.

import { useEffect, useRef, useState } from 'react';
import { gateway, useViewportPreferences } from '@forgeax/editor-core';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { isViewportInputReady, onViewportInputReadyChange } from './viewport/viewport';

/** Settable presets in menu order (UE: perspective first, then the six axis
 *  views). 'orthographic' is derive-only and never appears as a menu item. */
const MENU_VIEWS = ['perspective', 'top', 'bottom', 'left', 'right', 'front', 'back'] as const;
type MenuView = (typeof MENU_VIEWS)[number];

/** Shortcut hints shown next to menu items (UE single-hand bindings). */
const SHORTCUT_KEYS: Partial<Record<MenuView, string>> = {
  perspective: 'shortcutPerspective',
  front: 'shortcutFront',
  top: 'shortcutTop',
  left: 'shortcutLeft',
};

export function ViewportViewMenu() {
  const { t } = useTranslation();
  const { activeView } = useViewportPreferences();
  const [open, setOpen] = useState(false);
  // The camera session ops (cameraSetView …) register inside createViewport()
  // at the END of the async engine boot — the chrome mounts seconds earlier.
  // Stay disabled until input is live so a boot-window click can't dispatch
  // into a gateway with no applier and die silently.
  const [inputReady, setInputReady] = useState(() => isViewportInputReady());
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => onViewportInputReadyChange(setInputReady), []);

  // Close on any pointerdown outside the menu (the overlay layer is
  // click-through, so listen on window in the capture phase).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node | null)) {
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);

  const select = (view: MenuView): void => {
    setOpen(false);
    gateway.dispatch({ kind: 'cameraSetView', view }, 'human');
  };

  return (
    <div
      className="vp-view-menu"
      data-testid="vp-view-menu"
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
          event.currentTarget.querySelector<HTMLButtonElement>('.vp-view-label')?.focus();
        }
      }}
    >
      <button
        type="button"
        className={`vp-view-label${open ? ' on' : ''}`}
        data-testid="vp-view-label"
        title={t('editor.viewportView.menuTitle')}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!inputReady}
        onClick={() => setOpen((v) => !v)}
      >
        {t(`editor.viewportView.${activeView}`)}
        <span className="vp-view-caret">▾</span>
      </button>
      {open && (
        <div className="vp-view-dropdown" role="menu" data-testid="vp-view-dropdown">
          {MENU_VIEWS.map((view) => (
            <button
              key={view}
              type="button"
              role="menuitemradio"
              aria-checked={activeView === view}
              className={`vp-view-item${activeView === view ? ' on' : ''}`}
              data-testid={`vp-view-item-${view}`}
              onClick={() => select(view)}
            >
              <span>{t(`editor.viewportView.${view}`)}</span>
              {SHORTCUT_KEYS[view] && (
                <span className="vp-view-shortcut">{t(`editor.viewportView.${SHORTCUT_KEYS[view]}`)}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
