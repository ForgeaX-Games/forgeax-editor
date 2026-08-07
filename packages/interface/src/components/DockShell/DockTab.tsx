// Custom dockview tab — the default tab with a leading Lucide panel icon.
//
// Wired as `<DockviewReact defaultTabComponent={DockTab} />`, so every dock tab
// (static, ep:*, page-mode) gets an icon without touching per-panel registration.
//
// This is a faithful re-implementation of dockview's `DockviewDefaultTab`
// (node_modules/dockview .../dockview/defaultTab.js): it forwards the pointer
// handlers dockview injects for drag/activate and preserves the exact
// `.dv-default-tab` / `.dv-default-tab-content` / `.dv-default-tab-action` DOM
// hooks that `edgeDrawer.ts` mutates (pin-button injection). The only additions
// are a leading `.fx-dock-tab-icon` (inside `.dv-default-tab`, so the whole tab
// stays draggable/clickable) and a Lucide `X` close glyph (design-system on-brand,
// avoids a deep `dockview/.../svg` import).
import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactElement } from 'react';
import { X } from 'lucide-react';
import type { IDockviewDefaultTabProps } from 'dockview';
import { barePanelId, iconForDockPanel } from '../../lib/panel-tab-icons';
import { useTranslation } from '@/i18n';

/** Track the live tab title (dockview mutates it via `api.setTitle`). */
function useTitle(api: IDockviewDefaultTabProps['api']): string | undefined {
  const [title, setTitle] = useState(api.title);
  useEffect(() => {
    const disposable = api.onDidTitleChange((event) => setTitle(event.title));
    // Effect ordering can leave title stale on mount (dockview issue #1003).
    if (title !== api.title) setTitle(api.title);
    return () => disposable.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
  return title;
}

/**
 * The displayed tab name is DERIVED at render — never read from the persisted
 * layout. Same shape as the icon (`iconForDockPanel(api.id)`): the panel id is
 * the key, i18n is the lookup. `dockShell.panelTitles.<bareId>` wins and is
 * locale-reactive (useTranslation re-renders on language change), so a stored
 * `api.title` baked into the dockview layout JSON is ignored for keyed panels.
 * Panels without a catalog key (host-injected editor/extension panels) fall
 * back to the live `api.title` the host set at mount — their own name, as-is.
 */
function useDockTabName(api: IDockviewDefaultTabProps['api']): string | undefined {
  const stored = useTitle(api);
  const { t } = useTranslation();
  const key = `dockShell.panelTitles.${barePanelId(api.id)}`;
  const localized = t(key);
  return localized !== key ? localized : stored;
}

export function DockTab({
  api,
  containerApi: _containerApi,
  params: _params,
  hideClose,
  closeActionOverride,
  onPointerDown,
  onPointerUp,
  onPointerLeave,
  tabLocation: _tabLocation,
  ...rest
}: IDockviewDefaultTabProps): ReactElement {
  const title = useDockTabName(api);
  const Icon = iconForDockPanel(api.id);
  const isMiddleMouseButton = useRef(false);

  const onClose = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      if (closeActionOverride) closeActionOverride();
      else api.close();
    },
    [api, closeActionOverride],
  );
  const onBtnPointerDown = useCallback((event: PointerEvent) => event.preventDefault(), []);
  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      isMiddleMouseButton.current = event.button === 1;
      onPointerDown?.(event);
    },
    [onPointerDown],
  );
  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (isMiddleMouseButton.current && event.button === 1 && !hideClose) {
        isMiddleMouseButton.current = false;
        onClose(event);
      }
      onPointerUp?.(event);
    },
    [onPointerUp, onClose, hideClose],
  );
  const handlePointerLeave = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      isMiddleMouseButton.current = false;
      onPointerLeave?.(event);
    },
    [onPointerLeave],
  );

  return (
    <div
      data-testid="dockview-dv-default-tab"
      {...rest}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      className="dv-default-tab"
    >
      <Icon className="fx-dock-tab-icon" size={14} aria-hidden />
      <span className="dv-default-tab-content">{title}</span>
      {!hideClose && (
        <div className="dv-default-tab-action" onPointerDown={onBtnPointerDown} onClick={onClose}>
          <X size={14} aria-hidden />
        </div>
      )}
    </div>
  );
}
