import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useReducer,
  type ReactNode,
} from 'react';
import {
  AlertCircle,
  Bell,
  Box,
  Braces,
  Camera,
  Check,
  Clapperboard,
  Copy,
  Columns3,
  Crosshair,
  Database,
  Download,
  Eye,
  ExternalLink,
  FileCode2,
  FileText,
  Filter,
  Folder,
  FolderPlus,
  Globe,
  Grid2X2,
  Gamepad2,
  Image,
  Layers,
  List,
  LogOut,
  Magnet,
  Maximize2,
  Monitor,
  MoreHorizontal,
  Move,
  Music,
  Package,
  Pause,
  Play,
  Plus,
  ChevronDown,
  Redo2,
  RefreshCw,
  RotateCcw,
  Save,
  Settings,
  Sparkles,
  Square,
  Star,
  Trash2,
  Type,
  Undo2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { RecoveryBoundary } from '../ErrorBoundary';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover';
import { iconForDockPanel } from '../../lib/panel-tab-icons';
import { useHost } from '../../core/app-shell';
import {
  getContextExpressionKeys,
  resolvePanelActionState,
  type PanelActionContribution,
  type PanelCommandActionContribution,
  type PanelCommandMenuItemContribution,
  type PanelActionLocation,
  type PanelMenuActionContribution,
  type PanelMenuItemContribution,
  type PanelControlActionContribution,
} from '../../core/panels';
import type { PanelDescriptor } from '../DockShell/panelRenderers';
import './PanelShell.css';

const ICONS: Record<string, LucideIcon> = {
  AlertCircle,
  Bell,
  Box,
  Braces,
  Camera,
  ChevronDown,
  Check,
  Clapperboard,
  Columns3,
  Copy,
  Crosshair,
  Database,
  Download,
  Eye,
  FileCode2,
  FileText,
  Filter,
  ExternalLink,
  Folder,
  FolderPlus,
  Globe,
  Grid2X2,
  Gamepad2,
  Image,
  Layers,
  List,
  LogOut,
  Magnet,
  Maximize2,
  Monitor,
  Move,
  Music,
  Package,
  Pause,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  RotateCcw,
  Save,
  Settings,
  Sparkles,
  Square,
  Star,
  Trash2,
  Type,
  Undo2,
  X,
};

function ActionTooltip({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <TooltipProvider delayDuration={350} skipDelayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="fx-panel-tooltip-trigger">{children}</span>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" sideOffset={7}>
          {title}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

const LOCATION_RANK: Record<PanelActionLocation, number> = {
  'header/left': 0,
  'header/center': 1,
  'header/right': 2,
  context: 3,
};

/** Visual left→right toolbar order: zone first, then per-zone `order`.
 *  Sorting by `order` alone interleaves left/center/right (all use 10/20/…)
 *  and breaks both overflow fold priority and flyout item order. */
function compareActionsVisual(a: PanelActionContribution, b: PanelActionContribution): number {
  const locA = LOCATION_RANK[a.location ?? 'header/right'] ?? 2;
  const locB = LOCATION_RANK[b.location ?? 'header/right'] ?? 2;
  if (locA !== locB) return locA - locB;
  return (a.order ?? 0) - (b.order ?? 0);
}

function mergeActions(
  panelId: string,
  panelActions: readonly PanelActionContribution[],
  contributedActions: readonly PanelActionContribution[],
): readonly PanelActionContribution[] {
  const byId = new Map<string, PanelActionContribution>();
  for (const action of panelActions) byId.set(action.id, { ...action, panelId: action.panelId || panelId });
  for (const action of contributedActions) byId.set(action.id, action);
  return [...byId.values()].sort(compareActionsVisual);
}

function useActionRegistryVersion(): number {
  const host = useHost();
  return useSyncExternalStore(
    host.panelActions.onChange,
    () => host.panelActions.version(),
    () => 0,
  );
}

function useControlRegistryVersion(): number {
  const host = useHost();
  return useSyncExternalStore(
    host.panelControls.onChange,
    () => host.panelControls.version(),
    () => 0,
  );
}

interface ActionStateSource {
  readonly when?: string;
  readonly enablement?: string;
  readonly activeWhen?: string;
  readonly highlightWhen?: string;
}

function useContextExpressionVersion(action: ActionStateSource): number {
  const host = useHost();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const keys = useMemo(() => {
    const set = new Set<string>();
    for (const expr of [action.when, action.enablement, action.activeWhen, action.highlightWhen]) {
      for (const key of getContextExpressionKeys(expr)) set.add(key);
    }
    return [...set].sort();
  }, [action.activeWhen, action.enablement, action.highlightWhen, action.when]);

  useEffect(() => {
    if (keys.length === 0) return undefined;
    const cleanups = keys.map((key) => host.contextKeys.onChange(key, () => bump()));
    return () => { for (const cleanup of cleanups) void cleanup(); };
  }, [host, keys]);

  return keys.length;
}

function useContextKeyValue<T>(key: string | undefined): T | undefined {
  const host = useHost();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!key) return undefined;
    const cleanup = host.contextKeys.onChange(key, () => bump());
    return () => { void cleanup(); };
  }, [host, key]);
  return key ? host.contextKeys.get<T>(key) : undefined;
}

function executePanelCommand(
  host: ReturnType<typeof useHost>,
  command: string,
  panelId: string,
  actionId: string,
  location: PanelActionLocation,
  args: unknown,
): void {
  void host.commands.execute(command, {
    panelId,
    actionId,
    source: location === 'context' ? 'panel-context-menu' : 'panel-header',
    args,
  }).catch((err) => {
    console.error(`[panel-actions] command "${command}" failed`, err);
  });
}

const OverflowFlyoutContext = createContext(false);

function PanelCommandButton({
  action,
  panelId,
  location,
}: {
  action: PanelCommandActionContribution;
  panelId: string;
  location: PanelActionLocation;
}): ReactNode {
  const host = useHost();
  const inOverflow = useContext(OverflowFlyoutContext);
  useContextExpressionVersion(action);
  const state = resolvePanelActionState(action, host.contextKeys);
  if (!state.visible) return null;
  const Icon = action.icon ? ICONS[action.icon] : undefined;
  // In the flyout, always surface the title so icon-only header buttons remain
  // recognizable once relocated out of the toolbar.
  const label = action.label ?? (inOverflow || !Icon ? action.title : '');
  return (
    <ActionTooltip title={action.title}>
      <button
        type="button"
        className="fx-panel-action no-motion-lift"
        disabled={!state.enabled}
        data-panel-id={panelId}
        data-action-id={action.id}
        data-testid={action.testId}
        data-active={state.active ? 'true' : 'false'}
        data-highlight={state.highlighted ? 'true' : 'false'}
        data-has-label={label ? 'true' : 'false'}
        data-location={location}
        aria-label={action.title}
        onClick={() => executePanelCommand(host, action.command, panelId, action.id, location, action.args)}
      >
        {Icon && <Icon size={14} />}
        {label && <span className="fx-panel-action-label">{label}</span>}
      </button>
    </ActionTooltip>
  );
}

function PanelMenuItem({
  item,
  panelId,
  menuId,
}: {
  item: PanelMenuItemContribution;
  panelId: string;
  menuId: string;
}): ReactNode {
  const host = useHost();
  useContextExpressionVersion(item);
  const state = resolvePanelActionState(item, host.contextKeys);
  if (!state.visible) return null;
  if (item.kind === 'separator') return <DropdownMenuSeparator />;
  const Icon = item.icon ? ICONS[item.icon] : undefined;
  return (
    <DropdownMenuItem
      className={`fx-panel-menu-item${item.tone === 'reset' ? ' is-reset' : ''}`}
      disabled={!state.enabled}
      data-active={state.active ? 'true' : 'false'}
      data-highlight={state.highlighted ? 'true' : 'false'}
      onSelect={(event) => {
        if (item.checkable) event.preventDefault();
        executePanelCommand(host, item.command, panelId, item.id, 'header/right', item.args);
      }}
    >
      {item.checkable ? (
        <span className="fx-panel-menu-checkbox" data-checked={state.active ? 'true' : 'false'}>
          {state.active && <Check size={11} />}
        </span>
      ) : (
        <span className="fx-panel-menu-tico">
          {Icon && <Icon size={14} className="fx-panel-menu-icon" />}
        </span>
      )}
      {item.checkable && Icon && <Icon size={14} className="fx-panel-menu-icon" />}
      <span className="fx-panel-menu-label">{item.title}</span>
      <span className="fx-panel-menu-source">{menuId}</span>
    </DropdownMenuItem>
  );
}

function PanelMenuButton({
  action,
  panelId,
  location,
}: {
  action: PanelMenuActionContribution;
  panelId: string;
  location: Exclude<PanelActionLocation, 'context'>;
}): ReactNode {
  const host = useHost();
  useContextExpressionVersion(action);
  const state = resolvePanelActionState(action, host.contextKeys);
  const Icon = action.icon ? ICONS[action.icon] : undefined;
  const contextLabel = useContextKeyValue<string>(action.labelContextKey);
  const contextItems = useContextKeyValue<readonly PanelMenuItemContribution[]>(action.itemsContextKey);
  if (!state.visible) return null;
  const label = contextLabel ?? action.label ?? (!Icon ? action.title : '');
  const items = [...(contextItems ?? action.items)].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const bodyItems = items.filter((item) => item.kind !== 'separator' && item.tone !== 'reset');
  const footerItems = items.filter((item) => item.kind !== 'separator' && item.tone === 'reset');
  return (
    <DropdownMenu>
      <TooltipProvider delayDuration={350} skipDelayDuration={100}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="fx-panel-action no-motion-lift"
                disabled={!state.enabled}
                data-panel-id={panelId}
                data-action-id={action.id}
                data-testid={action.testId}
                data-active={state.active ? 'true' : 'false'}
                data-highlight={state.highlighted ? 'true' : 'false'}
                data-has-label={label ? 'true' : 'false'}
                data-location={location}
                aria-label={action.title}
              >
                {Icon && <Icon size={14} />}
                {label && <span className="fx-panel-action-label">{label}</span>}
                <ChevronDown size={12} />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center" sideOffset={7}>
            {action.title}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent className="fx-panel-menu" align={location === 'header/right' ? 'end' : 'start'} sideOffset={6}>
        <div className="fx-panel-menu-title">{action.title}</div>
        <div className="fx-panel-menu-scroll">
          {bodyItems.map((item) => (
            <PanelMenuItem key={item.id} item={item} panelId={panelId} menuId={action.id} />
          ))}
        </div>
        {footerItems.length > 0 && (
          <div className="fx-panel-menu-footer">
            <DropdownMenuSeparator />
            {footerItems.map((item) => (
              <PanelMenuItem key={item.id} item={item} panelId={panelId} menuId={action.id} />
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PanelActionControl({
  action,
  panelId,
  location,
}: {
  action: PanelActionContribution;
  panelId: string;
  location: PanelActionLocation;
}): ReactNode {
  if (action.kind === 'control') {
    if (location === 'context') return null;
    return <PanelRegisteredControl action={action} panelId={panelId} />;
  }
  if (action.kind === 'menu') {
    if (location === 'context') return null;
    return <PanelMenuButton action={action} panelId={panelId} location={location} />;
  }
  return <PanelCommandButton action={action} panelId={panelId} location={location} />;
}

function PanelRegisteredControl({
  action,
  panelId,
}: {
  action: PanelControlActionContribution;
  panelId: string;
}): ReactNode {
  const host = useHost();
  useControlRegistryVersion();
  useContextExpressionVersion(action);
  const state = resolvePanelActionState(action, host.contextKeys);
  if (!state.visible) return null;
  const control = host.panelControls.get(action.control);
  if (!control) return null;
  return (
    <div className="fx-panel-control" data-control={action.control} data-enabled={state.enabled ? 'true' : 'false'}>
      {control.render({ panelId, actionId: action.id })}
    </div>
  );
}

function OverflowMenu({
  panelId,
  actions,
  location,
}: {
  panelId: string;
  actions: readonly PanelActionContribution[];
  location: Exclude<PanelActionLocation, 'context'>;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const lockedRef = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = undefined;
    }
  };
  const scheduleClose = () => {
    clearClose();
    closeTimer.current = setTimeout(() => {
      if (!lockedRef.current) setOpen(false);
    }, 180);
  };
  useEffect(() => clearClose, []);
  const align = location === 'header/right' ? 'end' : location === 'header/center' ? 'center' : 'start';
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) lockedRef.current = false;
      }}
    >
      <PopoverAnchor asChild>
        <button
          type="button"
          className="fx-panel-action fx-panel-overflow-trigger no-motion-lift"
          data-panel-id={panelId}
          data-has-label="false"
          data-location={location}
          data-active={open ? 'true' : 'false'}
          aria-label="More actions"
          aria-expanded={open}
          onPointerEnter={() => {
            clearClose();
            setOpen(true);
          }}
          onPointerLeave={scheduleClose}
          onClick={() => {
            const next = !lockedRef.current;
            lockedRef.current = next;
            setOpen(next);
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      </PopoverAnchor>
      <PopoverContent
        className="fx-panel-overflow-flyout"
        style={{ width: 'auto' }}
        align={align}
        sideOffset={6}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={clearClose}
        onPointerLeave={scheduleClose}
      >
        <OverflowFlyoutContext.Provider value={true}>
          {actions.map((action) => (
            <PanelActionControl key={action.id} action={action} panelId={panelId} location={location} />
          ))}
        </OverflowFlyoutContext.Provider>
      </PopoverContent>
    </Popover>
  );
}

/** Default band for actions that omit `overflowPriority`. Zone-local `order` is
 *  NOT used — it would scramble fold order across left/center/right. Ties break
 *  by rightmost-first so the toolbar shrinks from the trailing edge. */
const DEFAULT_OVERFLOW_PRIORITY = 100;

function foldPriority(action: PanelActionContribution): number {
  return action.overflowPriority ?? DEFAULT_OVERFLOW_PRIORITY;
}

/** Separator controls become horizontal rules in the flyout — never leave one
 *  dangling at either end (or doubled up), which reads as a stray divider. */
function isSeparatorAction(action: PanelActionContribution): boolean {
  if (action.kind !== 'control') return false;
  return action.id.includes('separator') || action.control.includes('separator');
}

function sanitizeOverflowActions(
  actions: readonly PanelActionContribution[],
): PanelActionContribution[] {
  const trimmed: PanelActionContribution[] = [];
  for (const action of actions) {
    if (isSeparatorAction(action) && (trimmed.length === 0 || isSeparatorAction(trimmed[trimmed.length - 1]!))) {
      continue;
    }
    trimmed.push(action);
  }
  while (trimmed.length > 0 && isSeparatorAction(trimmed[trimmed.length - 1]!)) {
    trimmed.pop();
  }
  return trimmed;
}

const HEADER_LOCATIONS = ['header/left', 'header/center', 'header/right'] as const;

type HeaderLocation = (typeof HEADER_LOCATIONS)[number];

function headerLocationOf(action: PanelActionContribution): HeaderLocation {
  const location = action.location ?? 'header/right';
  return location === 'context' ? 'header/right' : location;
}

/**
 * Renders the panel header and folds its icon buttons into a hover flyout when
 * the header is too narrow. Folded actions keep the exact same
 * `PanelActionControl` rendering — they are relocated, not restyled. The fold is
 * decided for the header as a whole rather than per zone, so there is exactly
 * one overflow menu, and the budget comes from the header's own width — which
 * does not depend on the buttons — so folding cannot feed back into the
 * available width and oscillate.
 */
function PanelHeaderBar({ panelId, panel }: { panelId: string; panel: PanelDescriptor }): ReactNode {
  const host = useHost();
  const actionVersion = useActionRegistryVersion();
  const actions = useMemo(
    () => mergeActions(
      panelId,
      panel.actions ?? [],
      host.panelActions.list(panelId),
    ).filter((action) => (action.location ?? 'header/right') !== 'context'),
    [actionVersion, host, panel.actions, panelId],
  );

  const headerRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [foldCount, setFoldCount] = useState(0);

  const foldOrder = useMemo(
    () =>
      actions
        .map((action, index) => ({ action, index }))
        .filter(({ action }) => action.pinned !== true)
        .sort((a, b) => {
          const pa = foldPriority(a.action);
          const pb = foldPriority(b.action);
          if (pa !== pb) return pa - pb; // lower priority folds first
          return b.index - a.index; // otherwise the later (rightmost) folds first
        })
        .map(({ action }) => action.id),
    [actions],
  );
  const clampedFold = Math.min(foldCount, foldOrder.length);
  const foldedSet = useMemo(() => new Set(foldOrder.slice(0, clampedFold)), [foldOrder, clampedFold]);

  // Keep flyout order identical to the toolbar's left→right sequence.
  const overflow = sanitizeOverflowActions(
    actions
      .filter((action) => foldedSet.has(action.id) && action.hideOnOverflow !== true)
      .slice()
      .sort(compareActionsVisual),
  );

  // Deterministically derive the exact number of items to fold from the live
  // header width + measured per-item widths. Runs on every ResizeObserver tick
  // (panel drag) for BOTH header and measure row, so it handles grow and shrink
  // symmetrically without any "reset then converge" state dance.
  const recompute = useCallback(() => {
    const header = headerRef.current;
    const measure = measureRef.current;
    if (!header || !measure) return;

    const GAP = 6;
    const TRIGGER = 26;
    // Zones use the same gap as the toolbars inside them, so a button pair costs
    // one GAP wherever a zone border happens to fall. An empty zone still emits
    // its own gap; this slack absorbs that.
    const SLACK = 12;
    // Some Radix-wrapped controls measure as 0 inside the off-screen clone
    // (visibility:hidden + inert). Fall back to the live toolbar width, then to
    // a minimum, so those actions stay foldable instead of sticking on the bar.
    const MIN_ACTION_WIDTH = 30;
    const items = actions
      .map((action) => {
        const measured = measure.querySelector<HTMLElement>(`[data-fold-id="${CSS.escape(action.id)}"]`);
        let width = measured ? measured.getBoundingClientRect().width : 0;
        if (width <= 0.5) {
          const live = header.querySelector<HTMLElement>(`[data-fold-live-id="${CSS.escape(action.id)}"]`);
          width = live ? live.getBoundingClientRect().width : 0;
        }
        if (width <= 0.5) {
          // Still mounted in the live toolbar? Keep a seat so it can fold.
          const live = header.querySelector(`[data-fold-live-id="${CSS.escape(action.id)}"]`);
          if (!live) return { id: action.id, width: 0 };
          width = MIN_ACTION_WIDTH;
        }
        return { id: action.id, width };
      })
      .filter((item) => item.width > 0.5);

    const rowWidth = (widths: readonly number[]): number =>
      widths.reduce((sum, w) => sum + w, 0) + GAP * Math.max(0, widths.length - 1);

    const style = getComputedStyle(header);
    const titleWidth = titleRef.current?.getBoundingClientRect().width ?? 0;
    const available = header.clientWidth
      - parseFloat(style.paddingLeft)
      - parseFloat(style.paddingRight)
      - (titleWidth > 0 ? titleWidth + GAP : 0)
      - SLACK;

    const presentIds = new Set(items.map((item) => item.id));
    const foldable = foldOrder.filter((id) => presentIds.has(id));
    const dropped = new Set(
      actions.filter((action) => action.hideOnOverflow === true).map((action) => action.id),
    );

    const fits = (count: number): boolean => {
      const hidden = foldable.slice(0, count);
      const hiddenSet = new Set(hidden);
      const visibleWidths = items.filter((item) => !hiddenSet.has(item.id)).map((item) => item.width);
      let width = rowWidth(visibleWidths);
      // Folded-and-dropped actions never reach the flyout, so they alone do not
      // cost the trigger's width.
      if (hidden.some((id) => !dropped.has(id))) {
        width += TRIGGER + (visibleWidths.length > 0 ? GAP : 0);
      }
      return width <= available + 0.5;
    };

    let next = 0;
    while (next < foldable.length && !fits(next)) next += 1;
    setFoldCount(next);

    // The off-screen measure row duplicates every action's DOM purely to size
    // it (width is read via data-fold-id). Those clones also carry the consumer
    // data-testid (e.g. vp-play / vp-save), which would make getByTestId resolve
    // to two elements. Strip identity from the clones so queries and tests match
    // only the live visible instance.
    measure.querySelectorAll('[data-testid]').forEach((el) => el.removeAttribute('data-testid'));
  }, [actions, foldOrder]);

  useLayoutEffect(() => {
    // Keep the measure row out of the a11y tree, tab order and pointer/query
    // surface — it exists solely to measure natural widths off-screen.
    measureRef.current?.setAttribute('inert', '');
    recompute();
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(recompute);
    };
    const ro = new ResizeObserver(schedule);
    if (headerRef.current) ro.observe(headerRef.current);
    if (measureRef.current) ro.observe(measureRef.current);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [recompute]);

  return (
    <header className="fx-panel-header" ref={headerRef}>
      {HEADER_LOCATIONS.map((location) => {
        const zoneActions = actions.filter(
          (action) => headerLocationOf(action) === location && !foldedSet.has(action.id),
        );
        const showOverflow = location === 'header/right' && overflow.length > 0;
        return (
          <div key={location} className="fx-panel-header-zone" data-zone={location.slice('header/'.length)}>
            {location === 'header/left' && panel.header?.showTitle !== false && (() => {
              const PanelIcon = iconForDockPanel(panelId);
              return (
              <div className="fx-panel-title-block" ref={titleRef}>
                <PanelIcon className="fx-panel-icon" size={14} aria-hidden="true" />
                <div className="fx-panel-title-wrap">
                  <div className="fx-panel-title" title={panel.title}>{panel.title}</div>
                  {panel.header?.subtitle && <div className="fx-panel-subtitle">{panel.header.subtitle}</div>}
                </div>
              </div>
              );
            })()}
            {(zoneActions.length > 0 || showOverflow) && (
              <div className="fx-panel-toolbar" data-location={location}>
                {zoneActions.map((action) => (
                  <span key={action.id} data-fold-live-id={action.id} className="fx-panel-toolbar-item">
                    <PanelActionControl action={action} panelId={panelId} location={location} />
                  </span>
                ))}
                {showOverflow && (
                  <OverflowMenu panelId={panelId} actions={overflow} location="header/right" />
                )}
              </div>
            )}
          </div>
        );
      })}
      <div ref={measureRef} className="fx-panel-overflow-measure" aria-hidden="true">
        {actions.map((action) => (
          <span key={action.id} data-fold-id={action.id} className="fx-panel-overflow-measure-item">
            <PanelActionControl action={action} panelId={panelId} location={headerLocationOf(action)} />
          </span>
        ))}
      </div>
    </header>
  );
}

function PanelHeader({ panelId, panel }: { panelId: string; panel: PanelDescriptor }): ReactNode {
  if (panel.header?.visible !== true) return null;
  return <PanelHeaderBar panelId={panelId} panel={panel} />;
}

function PanelUnavailable({ id }: { id: string }): ReactNode {
  return (
    <div className="fx-panel-empty" data-panel={id} data-panel-unmounted="1">
      <div className="fx-panel-empty-title">Panel not mounted</div>
      <div className="fx-panel-empty-detail">{id}</div>
    </div>
  );
}

export function PanelShell({
  id,
  panel,
}: {
  id: string;
  panel?: PanelDescriptor;
}): ReactNode {
  const content = panel?.content;
  return (
    <section
      className="fx-panel"
      data-fx-slot={`DockPanel:${id}`}
      data-fx-panel-id={id}
      data-panel-registered={panel ? 'true' : 'false'}
      data-dock-single-tab={panel?.dockChrome?.singleTab ?? undefined}
    >
      {panel && <PanelHeader panelId={id} panel={panel} />}
      <div
        className="fx-panel-content"
        data-padding={content?.padding ?? 'none'}
        data-scroll={content?.scroll ?? 'auto'}
        data-tone={content?.tone ?? 'default'}
      >
        <RecoveryBoundary scope={`panel:${id}`} fullscreen={false}>
          {panel?.render() ?? <PanelUnavailable id={id} />}
        </RecoveryBoundary>
      </div>
    </section>
  );
}
