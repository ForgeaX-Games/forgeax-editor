import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import {
  AtSign,
  ChevronsRight,
  Copy,
  Crosshair,
  File,
  FolderSearch,
  Minus,
  Pin,
  Plus,
  Save,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useHost } from '../../core/app-shell';
import {
  PagePlatformError,
  isPageDirty,
  subscribePageDirty,
  type PageInstance,
  type PageMenuItem,
} from '../../core/page-platform';
import { unsavedChangesDialog } from '../../lib/dialog';
import { iconForPage } from '../../lib/page-tab-icons';
import { useTranslation } from '@/i18n';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import './PageTabStrip.css';

// Lucide glyphs for controller-contributed menu items (kebab name → component),
// same glyph set as the design demo's data-lucide names.
const MENU_ICON: Record<string, LucideIcon> = {
  copy: Copy,
  'folder-search': FolderSearch,
  crosshair: Crosshair,
  'at-sign': AtSign,
  save: Save,
};

/** Render controller-contributed items with a divider before each new group
 *  (including the first, to split them from the platform's base close group). */
function renderMenuItems(items: readonly PageMenuItem[]): ReactElement[] {
  const out: ReactElement[] = [];
  let lastGroup: string | undefined;
  items.forEach((item, i) => {
    if (i === 0 || item.group !== lastGroup) out.push(<DropdownMenuSeparator key={`sep-${item.id}`} />);
    lastGroup = item.group;
    const Icon = MENU_ICON[item.icon ?? ''] ?? File;
    out.push(
      <DropdownMenuItem key={item.id} disabled={item.disabled} onSelect={() => void item.run()}>
        <Icon aria-hidden />
        {item.label}
      </DropdownMenuItem>,
    );
  });
  return out;
}

/** Leaf name shown on a tab: owner-set live title → resource leaf → type title. */
function tabTitle(page: PageInstance, fallbackTitle: string | undefined): string {
  return (
    page.title ??
    page.resource?.displayPath?.split('/').at(-1) ??
    page.resource?.uri.split('/').at(-1) ??
    fallbackTitle ??
    page.typeId
  );
}

export function PageTabStrip(): ReactElement | null {
  const host = useHost();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(host.pages.subscribe, host.pages.getSnapshot, host.pages.getSnapshot);
  const registry = useSyncExternalStore(
    host.pageRegistry.subscribe,
    host.pageRegistry.getSnapshot,
    host.pageRegistry.getSnapshot,
  );

  const listRef = useRef<HTMLDivElement>(null);
  const dragKeyRef = useRef<string | null>(null);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  // Dirty state lives outside the page snapshot — a registered probe (e.g. the
  // Material Instance staging buffer) owns it, so re-render on its signal.
  const [, setDirtyTick] = useState(0);

  const { instances, activeKey } = snapshot;

  // Page types the "+" button can open blank — resource pages need a resource,
  // so only singleton / multi-instance types are eligible.
  const openableTypes = [...registry.pageTypes.values()]
    .filter((t) => t.status === 'available' && t.definition.cardinality !== 'resource')
    .map((t) => ({ typeId: t.definition.id, title: t.definition.title }));

  const focus = useCallback((key: string) => void host.pages.focus(key).catch(() => {}), [host]);

  // A page may refuse to close with unsaved staging; ask save / discard / cancel
  // and retry with the decision the platform expects.
  const closeKey = useCallback(
    (key: string) => {
      void (async () => {
        try {
          await host.pages.close(key);
        } catch (error) {
          if (!(error instanceof PagePlatformError) || error.code !== 'PAGE_CLOSE_REQUIRES_DECISION') return;
          const page = host.pages.getSnapshot().instances.find((p) => p.encodedKey === key);
          const resolved = page ? host.pageRegistry.get(page.typeId) : undefined;
          const title = page
            ? tabTitle(page, resolved?.status === 'available' ? resolved.definition.title : undefined)
            : key;
          const decision = await unsavedChangesDialog({
            title: t('dialog.unsavedTitle'),
            body: error.message || t('dialog.unsavedBody', { title }),
            saveText: t('common.save'),
            discardText: t('dialog.discardChanges'),
            cancelText: t('common.cancel'),
          });
          if (decision === 'cancel') return;
          await host.pages.close(key, { decision }).catch(() => {});
        }
      })();
    },
    [host, t],
  );

  useEffect(() => subscribePageDirty(() => setDirtyTick((n) => n + 1)), []);

  // Keep the active tab in view when the selection changes under overflow.
  useEffect(() => {
    if (!activeKey) return;
    listRef.current
      ?.querySelector(`[data-page-key="${CSS.escape(activeKey)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeKey]);

  // The overflow dropdown appears only when tabs can't all fit.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollWidth - el.clientWidth > 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [instances.length]);

  useEffect(() => {
    const end = () => {
      dragKeyRef.current = null;
      setDraggingKey(null);
    };
    window.addEventListener('pointerup', end);
    return () => window.removeEventListener('pointerup', end);
  }, []);

  const handleTabClick = useCallback(
    (key: string) => {
      // Clicking the already-active tab is a no-op (matches the demo).
      if (key === activeKey) return;
      focus(key);
    },
    [activeKey, focus],
  );

  const handlePointerDown = useCallback((event: ReactPointerEvent, key: string) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('[data-page-close]')) return;
    dragKeyRef.current = key;
  }, []);

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent) => {
      const dragKey = dragKeyRef.current;
      if (!dragKey || event.buttons !== 1) return;
      const overKey = (event.target as HTMLElement).closest('[data-page-key]')?.getAttribute('data-page-key');
      if (!overKey || overKey === dragKey) return;
      const toIndex = instances.findIndex((p) => p.encodedKey === overKey);
      if (toIndex < 0) return;
      setDraggingKey(dragKey);
      host.pages.reorder(dragKey, toIndex);
    },
    [host, instances],
  );

  if (instances.length === 0) return null;

  const menuPage = menu ? instances.find((p) => p.encodedKey === menu.key) : undefined;
  const menuIndex = menu ? instances.findIndex((p) => p.encodedKey === menu.key) : -1;
  // Controller-contributed items, evaluated fresh at open (live disabled/label).
  const menuItems = menu && menuPage ? host.pages.getContextMenuItems(menu.key) : [];

  return (
    <div className="page-tab-strip" data-fx-slot="PageTabs">
      <div className="page-tab-scope">
        <div
          ref={listRef}
          className="page-tab-list"
          role="tablist"
          aria-label={t('pageTabs.openPages')}
          onPointerMove={handlePointerMove}
        >
          {instances.map((page) => {
            const resolved = host.pageRegistry.get(page.typeId);
            const title = tabTitle(page, resolved?.status === 'available' ? resolved.definition.title : undefined);
            const active = activeKey === page.encodedKey;
            const dirty = isPageDirty(page);
            const Icon = iconForPage({ typeId: page.typeId, resource: page.resource });
            const path = page.resource?.displayPath ?? page.resource?.uri;
            const classes = [
              'page-tab',
              'no-motion-lift',
              active ? 'is-active' : '',
              page.closable ? '' : 'is-pinned',
              dirty ? 'is-dirty' : '',
              draggingKey === page.encodedKey ? 'is-drag' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <button
                key={page.encodedKey}
                type="button"
                className={classes}
                role="tab"
                aria-selected={active}
                data-page-key={page.encodedKey}
                data-dirty={dirty ? '1' : undefined}
                title={path ?? title}
                onClick={() => handleTabClick(page.encodedKey)}
                onAuxClick={(e) => {
                  if (e.button === 1 && page.closable) {
                    e.preventDefault();
                    closeKey(page.encodedKey);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, key: page.encodedKey });
                }}
                onPointerDown={(e) => handlePointerDown(e, page.encodedKey)}
              >
                <Icon className="page-tab__icon" aria-hidden />
                <span className="page-tab__label">{title}</span>
                {dirty && <span className="page-tab__dirty" aria-hidden>*</span>}
                {page.closable ? (
                  <span
                    className="page-tab__close no-motion-lift"
                    role="button"
                    aria-label={t('pageTabs.closeTab', { title })}
                    data-page-close={page.encodedKey}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeKey(page.encodedKey);
                    }}
                  >
                    <X className="page-tab__close-icon" aria-hidden />
                  </span>
                ) : (
                  <Pin className="page-tab__pin" aria-hidden />
                )}
              </button>
            );
          })}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="page-tab-btn page-tab-new no-motion-lift" title={t('pageTabs.newPage')} aria-label={t('pageTabs.newPage')}>
              <Plus className="page-tab-btn__icon" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[200px]">
            {openableTypes.length === 0 ? (
              <DropdownMenuItem disabled>{t('pageTabs.noOpenableTypes')}</DropdownMenuItem>
            ) : (
              openableTypes.map((t) => {
                const Icon = iconForPage({ typeId: t.typeId });
                return (
                  <DropdownMenuItem key={t.typeId} onSelect={() => void host.pages.open({ typeId: t.typeId }).catch(() => {})}>
                    <Icon aria-hidden />
                    {t.title}
                  </DropdownMenuItem>
                );
              })
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="page-tab-actions">
          {overflowing && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="page-tab-btn no-motion-lift" title={t('pageTabs.allPages')}>
                  <ChevronsRight className="page-tab-btn__icon" aria-hidden />
                  <span>{instances.length}</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[200px]">
                {instances.map((page) => {
                  const resolved = host.pageRegistry.get(page.typeId);
                  const title = tabTitle(page, resolved?.status === 'available' ? resolved.definition.title : undefined);
                  const Icon = iconForPage({ typeId: page.typeId, resource: page.resource });
                  return (
                    <DropdownMenuItem key={page.encodedKey} onSelect={() => focus(page.encodedKey)}>
                      <Icon aria-hidden />
                      <span className="page-tab-menu__mark">{activeKey === page.encodedKey ? '●' : '○'}</span>
                      <span className="page-tab-menu__label">
                        {isPageDirty(page) ? `${title} *` : title}
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Dedicated per-tab context menu (opt-out of the global menu host). */}
      <DropdownMenu open={menu !== null} onOpenChange={(open) => !open && setMenu(null)}>
        <DropdownMenuTrigger asChild>
          <span
            aria-hidden
            style={{ position: 'fixed', left: menu?.x ?? 0, top: menu?.y ?? 0, width: 0, height: 0 }}
          />
        </DropdownMenuTrigger>
        {menu && menuPage && (
          <DropdownMenuContent align="start" className="min-w-[186px]" onContextMenu={(e) => e.preventDefault()}>
            <DropdownMenuItem disabled={!menuPage.closable} onSelect={() => closeKey(menu.key)}>
              <X aria-hidden />
              {t('pageTabs.context.close')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                for (const p of instances) if (p.encodedKey !== menu.key && p.closable) closeKey(p.encodedKey);
                focus(menu.key);
              }}
            >
              <Minus aria-hidden />
              {t('pageTabs.context.closeOthers')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                for (const p of instances.slice(menuIndex + 1)) if (p.closable) closeKey(p.encodedKey);
              }}
            >
              <ChevronsRight aria-hidden />
              {t('pageTabs.context.closeToRight')}
            </DropdownMenuItem>
            {renderMenuItems(menuItems)}
          </DropdownMenuContent>
        )}
      </DropdownMenu>
    </div>
  );
}
