import { useEffect, useMemo, useSyncExternalStore, useReducer, type ReactNode } from 'react';
import {
  AlertCircle,
  Bell,
  Box,
  Camera,
  Check,
  Copy,
  Columns3,
  Crosshair,
  Download,
  Eye,
  ExternalLink,
  Filter,
  FolderPlus,
  Globe,
  Grid2X2,
  Gamepad2,
  List,
  LogOut,
  Magnet,
  Maximize2,
  Monitor,
  Move,
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
  Camera,
  ChevronDown,
  Check,
  Columns3,
  Copy,
  Crosshair,
  Download,
  Eye,
  Filter,
  ExternalLink,
  FolderPlus,
  Globe,
  Grid2X2,
  Gamepad2,
  List,
  LogOut,
  Magnet,
  Maximize2,
  Monitor,
  Move,
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
  return (
    <div className="fx-panel-toolbar" data-location={location}>
      {actions.map((action) => (
        <PanelActionControl key={action.id} action={action} panelId={panelId} location={location} />
      ))}
    </div>
  );
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
