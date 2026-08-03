import {
  useCallback,
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

function mergeActions(
  panelId: string,
  panelActions: readonly PanelActionContribution[],
  contributedActions: readonly PanelActionContribution[],
): readonly PanelActionContribution[] {
  const byId = new Map<string, PanelActionContribution>();
  for (const action of panelActions) byId.set(action.id, { ...action, panelId: action.panelId || panelId });
  for (const action of contributedActions) byId.set(action.id, action);
  return [...byId.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
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
  useContextExpressionVersion(action);
  const state = resolvePanelActionState(action, host.contextKeys);
  if (!state.visible) return null;
  const Icon = action.icon ? ICONS[action.icon] : undefined;
  const label = action.label ?? (!Icon ? action.title : '');
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
        {actions.map((action) => (
          <PanelActionControl key={action.id} action={action} panelId={panelId} location={location} />
        ))}
      </PopoverContent>
    </Popover>
  );
}

function foldPriority(action: PanelActionContribution): number {
  return action.overflowPriority ?? action.order ?? 0;
}

/**
 * Renders a header toolbar zone whose icon buttons fold into a hover flyout when
 * the zone is too narrow. Folded actions keep the exact same `PanelActionControl`
 * rendering — they are relocated, not restyled. Natural (unfolded) width is
 * measured off-screen so the flex-basis stays constant, which prevents the
 * fold→shrink→fold oscillation that a content-sized container would cause.
 */
function OverflowGroup({
  panelId,
  actions,
  location,
}: {
  panelId: string;
  actions: readonly PanelActionContribution[];
  location: Exclude<PanelActionLocation, 'context'>;
}): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [foldCount, setFoldCount] = useState(0);
  const [naturalWidth, setNaturalWidth] = useState<number | undefined>(undefined);

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
  const maxFold = foldOrder.length;
  const clampedFold = Math.min(foldCount, maxFold);
  const foldedSet = useMemo(() => new Set(foldOrder.slice(0, clampedFold)), [foldOrder, clampedFold]);

  const visible = actions.filter((action) => !foldedSet.has(action.id));
  const overflow = actions.filter((action) => foldedSet.has(action.id));

  // Deterministically derive the exact number of items to fold from the live
  // container width + measured per-item widths. Runs on every ResizeObserver
  // tick (panel drag) for BOTH container and measure row, so it handles grow
  // and shrink symmetrically without any "reset then converge" state dance.
  const recompute = useCallback(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;

    const GAP = 6;
    const TRIGGER = 26;
    const items = actions
      .map((action) => {
        const el = measure.querySelector<HTMLElement>(`[data-fold-id="${CSS.escape(action.id)}"]`);
        return { id: action.id, width: el ? el.getBoundingClientRect().width : 0 };
      })
      .filter((item) => item.width > 0.5);

    const rowWidth = (widths: readonly number[]): number =>
      widths.reduce((sum, w) => sum + w, 0) + GAP * Math.max(0, widths.length - 1);

    setNaturalWidth(Math.ceil(rowWidth(items.map((item) => item.width))));

    const available = container.clientWidth;
    const presentIds = new Set(items.map((item) => item.id));
    const foldable = foldOrder.filter((id) => presentIds.has(id));

    const fits = (count: number): boolean => {
      const hidden = new Set(foldable.slice(0, count));
      const visibleWidths = items.filter((item) => !hidden.has(item.id)).map((item) => item.width);
      let width = rowWidth(visibleWidths);
      if (count > 0) width += TRIGGER + (visibleWidths.length > 0 ? GAP : 0);
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
    if (containerRef.current) ro.observe(containerRef.current);
    if (measureRef.current) ro.observe(measureRef.current);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [recompute]);

  if (actions.length === 0) return null;
  return (
    <>
      <div
        ref={containerRef}
        className="fx-panel-toolbar fx-panel-toolbar-overflow"
        data-location={location}
        style={naturalWidth != null ? { flexBasis: `${naturalWidth}px` } : undefined}
      >
        {visible.map((action) => (
          <PanelActionControl key={action.id} action={action} panelId={panelId} location={location} />
        ))}
        {overflow.length > 0 && <OverflowMenu panelId={panelId} actions={overflow} location={location} />}
      </div>
      <div ref={measureRef} className="fx-panel-overflow-measure" aria-hidden="true">
        {actions.map((action) => (
          <span key={action.id} data-fold-id={action.id} className="fx-panel-overflow-measure-item">
            <PanelActionControl action={action} panelId={panelId} location={location} />
          </span>
        ))}
      </div>
    </>
  );
}

function PanelToolbar({
  panelId,
  panel,
  location,
}: {
  panelId: string;
  panel: PanelDescriptor;
  location: PanelActionLocation;
}): ReactNode {
  const host = useHost();
  const actionVersion = useActionRegistryVersion();
  const actions = useMemo(() => mergeActions(
    panelId,
    panel.actions ?? [],
    host.panelActions.list(panelId),
  ).filter((action) => (action.location ?? 'header/right') === location), [actionVersion, host, location, panel.actions, panelId]);

  if (actions.length === 0) return null;
  if (location === 'context') {
    return (
      <div className="fx-panel-toolbar" data-location={location}>
        {actions.map((action) => (
          <PanelActionControl key={action.id} action={action} panelId={panelId} location={location} />
        ))}
      </div>
    );
  }
  return <OverflowGroup panelId={panelId} actions={actions} location={location} />;
}

function PanelHeader({ panelId, panel }: { panelId: string; panel: PanelDescriptor }): ReactNode {
  if (panel.header?.visible !== true) return null;
  return (
    <header className="fx-panel-header">
      <div className="fx-panel-header-zone" data-zone="left">
        {panel.header?.showTitle !== false && (
          <>
            {panel.icon && <span className="fx-panel-icon" aria-hidden="true">{panel.icon}</span>}
            <div className="fx-panel-title-wrap">
              <div className="fx-panel-title" title={panel.title}>{panel.title}</div>
              {panel.header?.subtitle && <div className="fx-panel-subtitle">{panel.header.subtitle}</div>}
            </div>
          </>
        )}
        <PanelToolbar panelId={panelId} panel={panel} location="header/left" />
      </div>
      <div className="fx-panel-header-zone" data-zone="center">
        <PanelToolbar panelId={panelId} panel={panel} location="header/center" />
      </div>
      <div className="fx-panel-header-zone" data-zone="right">
        <PanelToolbar panelId={panelId} panel={panel} location="header/right" />
      </div>
    </header>
  );
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
