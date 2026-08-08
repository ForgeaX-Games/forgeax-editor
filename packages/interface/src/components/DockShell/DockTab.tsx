// Custom dockview tab — the default tab with a leading Lucide panel icon.
//
// Wired as `<DockviewReact defaultTabComponent={DockTab} />`, so every dock tab
// (static, ep:*, page-mode) gets an icon without touching per-panel registration.
//
// This is a faithful re-implementation of dockview's `DockviewDefaultTab`
// (node_modules/dockview .../dockview/defaultTab.js): it forwards the pointer
// handlers dockview injects for drag/activate and preserves the exact
// `.dv-default-tab` / `.dv-default-tab-content` / `.dv-default-tab-action` DOM
// hooks the stylesheets and `edgeDrawer.ts`'s click routing key off. The
// additions are a leading `.fx-dock-tab-icon` (inside `.dv-default-tab`, so the
// whole tab stays draggable/clickable), a Lucide `X` close glyph (design-system
// on-brand, avoids a deep `dockview/.../svg` import), and a Lucide `Pin` that
// takes the X's place on edge-strip tabs (see `useEdgePin` below).
//
// CLOSE BUTTON: React synthetic events and native mousedown/click are
// unreliable here because calling preventDefault() on pointerdown (needed to
// prevent tab activation) suppresses subsequent mousedown/click per the W3C
// Pointer Events spec. We bypass React entirely and handle close directly on
// a native `pointerdown` listener via ref+useEffect.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
  type ReactElement,
} from 'react';
import { Pin, X } from 'lucide-react';
import type { IDockviewDefaultTabProps } from 'dockview';
import { barePanelId, iconForDockPanel } from '../../lib/panel-tab-icons';
import { EDGE_PIN_CLASS, pinnedPanelIdIn, subscribeEdgePins } from './edgePinStore';
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

/**
 * Edge-strip tabs show a per-tab Pin toggle where a grid tab shows close (X) —
 * see edgeDrawer.ts for the rules. Both bits are DERIVED from live dockview
 * state, so the first paint after a refresh is already correct:
 * `onDidLocationChange` fires on any group change (dockviewPanelApi sets it from
 * the `group` setter), which covers dragging a panel into or out of a strip.
 */
function useEdgePin(api: IDockviewDefaultTabProps['api']): { isEdge: boolean; pinned: boolean } {
  const readHome = useCallback(
    () => ({ isEdge: api.location.type === 'edge', groupId: api.group.id }),
    [api],
  );
  const [home, setHome] = useState(readHome);
  useEffect(() => {
    const sync = (): void =>
      setHome((prev) => {
        const next = readHome();
        return prev.isEdge === next.isEdge && prev.groupId === next.groupId ? prev : next;
      });
    sync();
    const disposable = api.onDidLocationChange(sync);
    return () => disposable.dispose();
  }, [api, readHome]);
  const pinned = useSyncExternalStore(
    subscribeEdgePins,
    () => pinnedPanelIdIn(home.groupId) === api.id,
  );
  return { isEdge: home.isEdge, pinned };
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
  const { isEdge, pinned } = useEdgePin(api);
  const isMiddleMouseButton = useRef(false);
  const closeRef = useRef<HTMLDivElement>(null);

  // Native DOM listener on the close button — bypasses React event delegation
  // which is unreliable inside dockview's vanilla-JS portal container.
  // Must handle close on `pointerdown` because calling preventDefault() on
  // pointerdown suppresses subsequent mousedown/click (W3C Pointer Events spec).
  useEffect(() => {
    const el = closeRef.current;
    if (!el) return;

    const onPointerDownClose = (ev: globalThis.PointerEvent): void => {
      ev.preventDefault();
      ev.stopPropagation();
      try {
        if (closeActionOverride) closeActionOverride();
        else api.close();
      } catch { /* panel may already be disposed */ }
    };

    el.addEventListener('pointerdown', onPointerDownClose);
    return () => {
      el.removeEventListener('pointerdown', onPointerDownClose);
    };
  }, [api, closeActionOverride]);

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
        if (closeActionOverride) closeActionOverride();
        else api.close();
      }
      onPointerUp?.(event);
    },
    [onPointerUp, api, closeActionOverride, hideClose],
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
      {!hideClose &&
        (isEdge ? (
          // The toggle itself is driven by edgeDrawer's capture-phase click
          // handler (it must preventDefault dockview's native expand before the
          // event ever reaches React), so this renders state and carries the
          // panel id that handler reads back — no onClick of its own.
          <div
            className={`dv-default-tab-action ${EDGE_PIN_CLASS}${pinned ? ` ${EDGE_PIN_CLASS}--on` : ''}`}
            data-fx-edge-pin-panel={api.id}
            role="button"
            aria-pressed={pinned}
            aria-label={pinned ? 'Unpin tab' : 'Pin tab'}
            title={pinned ? 'Unpin' : 'Pin'}
            onPointerDown={onBtnPointerDown}
          >
            <Pin className="fx-edge-pin-icon" size={12} aria-hidden />
          </div>
        ) : (
          <div ref={closeRef} className="dv-default-tab-action">
            <X size={14} aria-hidden />
          </div>
        ))}
    </div>
  );
}
