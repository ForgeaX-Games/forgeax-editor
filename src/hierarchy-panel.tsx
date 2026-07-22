import { useEffect, useReducer, useSyncExternalStore, type ChangeEvent, type ReactNode } from 'react';
import {
  Box,
  Filter,
  Flag,
  Maximize2,
  Minimize2,
  Settings,
  Search,
  Sun,
  Target,
  User,
  Video,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { AppExtension, AppHost } from '@forgeax/interface/core/app-shell/types';
import { useHost } from '@forgeax/interface/core/app-shell';
import { Input } from '@forgeax/editor-ui/input';
import { Button } from '@forgeax/editor-ui/button';
import { Checkbox } from '@forgeax/editor-ui/checkbox';
import { useTranslation } from '@forgeax/editor-core/i18n';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@forgeax/editor-ui/dropdown-menu';
import {
  buildPresetComponents,
  ENTITY_PRESETS,
  entComponents,
  entExists,
  entName,
  gateway,
  getPreset,
  getSelection,
  getSelectionList,
  onSelectionChange,
  requestRefEntity,
} from '@forgeax/editor-core';
import {
  clearHierarchyFilters,
  clearHierarchySearchQuery,
  collapseHierarchyAll,
  expandHierarchyAll,
  getHierarchyFilterOptions,
  getHierarchyPanelSnapshot,
  setHierarchySearchQuery,
  subscribeHierarchyPanelState,
  toggleHierarchyColumn,
  toggleHierarchyFilter,
  type HierarchyColumns,
} from '../packages/panels/src/hierarchy-state';
import './hierarchy-panel.css';

type CommandPayload = { args?: unknown } | undefined;

function commandResult(): { status: 'completed' } {
  return { status: 'completed' };
}

function payloadArgs<T extends Record<string, unknown>>(payload: unknown): Partial<T> {
  if (typeof payload !== 'object' || payload === null) return {};
  const maybeArgs = (payload as CommandPayload)?.args;
  return typeof maybeArgs === 'object' && maybeArgs !== null ? maybeArgs as Partial<T> : {};
}

function setContextKeys(host: AppHost, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) host.contextKeys.set(key, value);
}

function filterKey(id: string): string {
  return `panel.hierarchy.filter.${id.replace(/[^\w:-]/g, '_')}`;
}

function syncHierarchyContext(host: AppHost): void {
  const state = getHierarchyPanelSnapshot();
  const selection = getSelection();
  const selectionList = getSelectionList();
  const readOnly = gateway.mode === 'play';
  const filterOptions = getHierarchyFilterOptions();

  const keys: Record<string, unknown> = {
    'panel.hierarchy.mounted': true,
    'panel.hierarchy.worldReady': gateway.activeWorld != null,
    'panel.hierarchy.readOnly': readOnly,
    'panel.hierarchy.hasSelection': selection !== null,
    'panel.hierarchy.multiSelection': selectionList.size > 1,
    'panel.hierarchy.canGroup': !readOnly && selectionList.size > 1,
    'panel.hierarchy.canDelete': !readOnly && selection !== null,
    'panel.hierarchy.canDuplicate': !readOnly && selection !== null,
    'panel.hierarchy.searchQuery': state.searchQuery,
    'panel.hierarchy.filterCount': state.filters.size,
    'panel.hierarchy.filter.label': state.filters.size === 0 ? 'All' : `${state.filters.size} filters`,
    'panel.hierarchy.column.type': state.columns.type,
    'panel.hierarchy.column.mobility': state.columns.mobility,
    'panel.hierarchy.column.id': state.columns.id,
  };
  for (const option of filterOptions) keys[filterKey(option.id)] = state.filters.has(option.id);
  setContextKeys(host, keys);
}

function spawnEntity(): void {
  gateway.dispatch({
    kind: 'spawnEntity',
    name: 'Entity',
    parent: getSelection(),
    components: { Transform: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  });
}

function spawnPreset(label: string | undefined): void {
  if (!label) return;
  const preset = getPreset(label);
  if (!preset) return;
  gateway.dispatch({
    kind: 'spawnEntity',
    name: preset.label,
    parent: getSelection(),
    components: buildPresetComponents(preset),
  });
}

function copySelectionJson(): void {
  const id = getSelection();
  const world = gateway.activeWorld;
  if (id === null || !world || !entExists(world, id)) return;
  void navigator.clipboard?.writeText(JSON.stringify({
    id,
    name: entName(world, id),
    components: entComponents(world, id),
  }, null, 2));
}

function registerHierarchyCommands(host: AppHost): Array<() => void> {
  return [
    host.commands.register({
      id: 'hierarchy.disabled',
      title: 'Hierarchy: Unavailable prototype action',
      execute: () => commandResult(),
    }),
    host.commands.register({
      id: 'hierarchy.create.entity',
      title: 'Hierarchy: Create entity',
      execute: () => { spawnEntity(); return commandResult(); },
    }),
    host.commands.register({
      id: 'hierarchy.create.preset',
      title: 'Hierarchy: Create preset entity',
      execute: (payload: unknown) => {
        spawnPreset(payloadArgs<{ preset: string }>(payload).preset);
        return commandResult();
      },
    }),
    host.commands.register({
      id: 'hierarchy.duplicate',
      title: 'Hierarchy: Duplicate selected entity',
      execute: () => commandResult(),
    }),
    host.commands.register({
      id: 'hierarchy.group',
      title: 'Hierarchy: Group selected entities',
      execute: () => commandResult(),
    }),
    host.commands.register({
      id: 'hierarchy.delete',
      title: 'Hierarchy: Delete selected entities',
      execute: () => commandResult(),
    }),
    host.commands.register({
      id: 'hierarchy.rename',
      title: 'Hierarchy: Rename selected entity',
      execute: () => {
        const selection = getSelection();
        if (selection !== null) gateway.dispatch({ kind: 'requestRename', entity: selection });
        return commandResult();
      },
    }),
    host.commands.register({
      id: 'hierarchy.copyJson',
      title: 'Hierarchy: Copy selected entity JSON',
      execute: () => { copySelectionJson(); return commandResult(); },
    }),
    host.commands.register({
      id: 'hierarchy.refToChat',
      title: 'Hierarchy: Reference selected entity in chat',
      execute: () => {
        const selection = getSelection();
        if (selection !== null) requestRefEntity(selection);
        return commandResult();
      },
    }),
    host.commands.register({
      id: 'hierarchy.search.set',
      title: 'Hierarchy: Set search query',
      execute: (payload: unknown) => {
        const value = payloadArgs<{ value: string }>(payload).value;
        setHierarchySearchQuery(typeof value === 'string' ? value : '');
        return commandResult();
      },
    }),
    host.commands.register({
      id: 'hierarchy.search.clear',
      title: 'Hierarchy: Clear search query',
      execute: () => { clearHierarchySearchQuery(); return commandResult(); },
    }),
    host.commands.register({
      id: 'hierarchy.filter.toggle',
      title: 'Hierarchy: Toggle component filter',
      execute: (payload: unknown) => {
        const filterId = payloadArgs<{ filterId: string }>(payload).filterId;
        if (typeof filterId === 'string') toggleHierarchyFilter(filterId);
        return commandResult();
      },
    }),
    host.commands.register({
      id: 'hierarchy.filter.clear',
      title: 'Hierarchy: Clear component filters',
      execute: () => { clearHierarchyFilters(); return commandResult(); },
    }),
    host.commands.register({
      id: 'hierarchy.column.toggle',
      title: 'Hierarchy: Toggle column',
      execute: (payload: unknown) => {
        const column = payloadArgs<{ column: keyof HierarchyColumns }>(payload).column;
        if (column === 'type' || column === 'mobility' || column === 'id') toggleHierarchyColumn(column);
        return commandResult();
      },
    }),
    host.commands.register({
      id: 'hierarchy.expandAll',
      title: 'Hierarchy: Expand all',
      execute: () => { expandHierarchyAll(); return commandResult(); },
    }),
    host.commands.register({
      id: 'hierarchy.collapseAll',
      title: 'Hierarchy: Collapse all',
      execute: () => { collapseHierarchyAll(); return commandResult(); },
    }),
  ];
}

function usePanelContextKey<T>(key: string): T | undefined {
  const host = useHost();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const cleanup = host.contextKeys.onChange(key, () => bump());
    return () => { void cleanup(); };
  }, [host, key]);
  return host.contextKeys.get<T>(key);
}

function executeHierarchyCommand(host: ReturnType<typeof useHost>, command: string, args?: unknown): void {
  void host.commands.execute(command, {
    source: 'panel-header',
    args,
  }).catch((err: unknown) => {
    console.error(`[hierarchy-panel] command "${command}" failed`, err);
  });
}

function hierarchyFilterIcon(id: string): LucideIcon {
  switch (id) {
    case 'character': return User;
    case 'light': return Sun;
    case 'camera': return Video;
    case 'start': return Flag;
    case 'spawner': return Target;
    default: return Box;
  }
}

function hierarchyTypeI18nKey(id: string): string {
  switch (id) {
    case 'character': return 'character';
    case 'mesh': return 'staticMesh';
    case 'light': return 'light';
    case 'camera': return 'camera';
    case 'start': return 'playerStart';
    case 'spawner': return 'spawner';
    case 'group': return 'group';
    case 'folder': return 'folder';
    default: return 'entity';
  }
}

function HierarchySearchControl(): ReactNode {
  const host = useHost();
  const { t } = useTranslation();
  const value = usePanelContextKey<string>('panel.hierarchy.searchQuery') ?? '';
  return (
    <div className="hierarchy-search-control">
      <Search className="hierarchy-search-icon" size={13} aria-hidden="true" />
      <Input
        className="hierarchy-search-input"
        type="search"
        size="sm"
        value={value}
        placeholder={t('editor.hierarchy.searchPlaceholder')}
        aria-label={t('editor.hierarchy.searchAria')}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          executeHierarchyCommand(host, 'hierarchy.search.set', { value: event.target.value });
        }}
      />
      <Button
        className="hierarchy-search-clear"
        type="button"
        variant="ghost"
        size="iconSm"
        disabled={!value}
        title={t('editor.hierarchy.clearSearch')}
        aria-label={t('editor.hierarchy.clearSearch')}
        onClick={() => executeHierarchyCommand(host, 'hierarchy.search.clear')}
      >
        <X size={13} />
      </Button>
    </div>
  );
}

function HierarchyFilterControl(): ReactNode {
  const host = useHost();
  const { t } = useTranslation();
  const state = useSyncExternalStore(
    subscribeHierarchyPanelState,
    getHierarchyPanelSnapshot,
    getHierarchyPanelSnapshot,
  );
  const options = getHierarchyFilterOptions();
  const active = state.filters.size > 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="hierarchy-header-icon"
          type="button"
          variant="chrome"
          size="iconSm"
          title={t('editor.hierarchy.filterByType')}
          aria-label={t('editor.hierarchy.filterByType')}
          data-active={active ? 'true' : 'false'}
        >
          <Filter size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="hierarchy-header-menu hierarchy-header-menu-filter">
        <DropdownMenuLabel className="hierarchy-dd-title">{t('editor.hierarchy.filterByType')}</DropdownMenuLabel>
        {options.map((option) => (
          (() => {
            const Icon = hierarchyFilterIcon(option.id);
            return (
              <DropdownMenuItem
                key={option.id}
                className="hierarchy-dd-item"
                size="sm"
                onSelect={(event) => {
                  event.preventDefault();
                  executeHierarchyCommand(host, 'hierarchy.filter.toggle', { filterId: option.id });
                }}
              >
                <Checkbox
                  className="hierarchy-dd-checkbox"
                  size="menu"
                  checked={state.filters.has(option.id)}
                  tabIndex={-1}
                  aria-hidden="true"
                />
                <span className="hierarchy-dd-tico"><Icon size={14} /></span>
                <span>{t(`editor.hierarchy.types.${hierarchyTypeI18nKey(option.id)}`)}</span>
              </DropdownMenuItem>
            );
          })()
        ))}
        <DropdownMenuSeparator className="hierarchy-dd-sep" />
        <DropdownMenuItem
          className="hierarchy-dd-item hierarchy-dd-action"
          size="sm"
          disabled={!active}
          onSelect={() => executeHierarchyCommand(host, 'hierarchy.filter.clear')}
        >
          <span className="hierarchy-dd-tico"><X size={14} /></span>
          <span>{t('editor.contentBrowser.actions.clearFilters')}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function HierarchySettingsControl(): ReactNode {
  const host = useHost();
  const { t } = useTranslation();
  const typeColumn = usePanelContextKey<boolean>('panel.hierarchy.column.type') ?? true;
  const mobilityColumn = usePanelContextKey<boolean>('panel.hierarchy.column.mobility') ?? true;
  const idColumn = usePanelContextKey<boolean>('panel.hierarchy.column.id') ?? false;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="hierarchy-header-icon"
          type="button"
          variant="chrome"
          size="iconSm"
          title={t('editor.hierarchy.columns.title')}
          aria-label={t('editor.hierarchy.columns.title')}
        >
          <Settings size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="hierarchy-header-menu hierarchy-header-menu-settings">
        <DropdownMenuLabel className="hierarchy-dd-title">{t('editor.hierarchy.columns.title')}</DropdownMenuLabel>
        <DropdownMenuItem
          className="hierarchy-dd-item"
          size="sm"
          onSelect={(event) => {
            event.preventDefault();
            executeHierarchyCommand(host, 'hierarchy.column.toggle', { column: 'type' });
          }}
        >
          <Checkbox className="hierarchy-dd-checkbox" size="menu" checked={typeColumn} tabIndex={-1} aria-hidden="true" />
          {t('editor.hierarchy.columns.type')}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="hierarchy-dd-item"
          size="sm"
          onSelect={(event) => {
            event.preventDefault();
            executeHierarchyCommand(host, 'hierarchy.column.toggle', { column: 'mobility' });
          }}
        >
          <Checkbox className="hierarchy-dd-checkbox" size="menu" checked={mobilityColumn} tabIndex={-1} aria-hidden="true" />
          {t('editor.hierarchy.columns.mobility')}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="hierarchy-dd-item"
          size="sm"
          onSelect={(event) => {
            event.preventDefault();
            executeHierarchyCommand(host, 'hierarchy.column.toggle', { column: 'id' });
          }}
        >
          <Checkbox className="hierarchy-dd-checkbox" size="menu" checked={idColumn} tabIndex={-1} aria-hidden="true" />
          {t('editor.hierarchy.columns.id')}
        </DropdownMenuItem>
        <DropdownMenuSeparator className="hierarchy-dd-sep" />
        <DropdownMenuItem className="hierarchy-dd-item hierarchy-dd-action" size="sm" onSelect={() => executeHierarchyCommand(host, 'hierarchy.expandAll')}>
          <span className="hierarchy-dd-tico"><Maximize2 size={14} /></span>
          <span>{t('editor.hierarchy.menu.expandAll')}</span>
        </DropdownMenuItem>
        <DropdownMenuItem className="hierarchy-dd-item hierarchy-dd-action" size="sm" onSelect={() => executeHierarchyCommand(host, 'hierarchy.collapseAll')}>
          <span className="hierarchy-dd-tico"><Minimize2 size={14} /></span>
          <span>{t('editor.hierarchy.menu.collapseAll')}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function createHierarchyPanelContributionsExtension(): AppExtension {
  return {
    id: 'editor.hierarchy-panel-contributions',
    version: '1.0.0',
    requires: ['commands', 'panelActions', 'panelControls', 'contextKeys'],
    setup(ctx) {
      const host = ctx.host;
      syncHierarchyContext(host);
      const cleanups: Array<() => void> = [
        ...registerHierarchyCommands(host),
        ctx.contributePanelControls([
          { id: 'hierarchy.filter', render: () => <HierarchyFilterControl /> },
          { id: 'hierarchy.search', render: () => <HierarchySearchControl /> },
          { id: 'hierarchy.settings', render: () => <HierarchySettingsControl /> },
        ]),
        ctx.contributePanelActions([
          {
            kind: 'control',
            id: 'hierarchy.filter.control',
            panelId: 'hierarchy',
            control: 'hierarchy.filter',
            location: 'header/left',
            order: 10,
            enablement: 'panel.hierarchy.mounted',
          },
          {
            kind: 'control',
            id: 'hierarchy.search.control',
            panelId: 'hierarchy',
            control: 'hierarchy.search',
            location: 'header/left',
            order: 20,
            enablement: 'panel.hierarchy.mounted',
          },
          {
            id: 'hierarchy.newFolder.action',
            panelId: 'hierarchy',
            command: 'hierarchy.disabled',
            title: 'New Folder',
            icon: 'FolderPlus',
            location: 'header/left',
            order: 30,
            enablement: 'false',
          },
          {
            kind: 'control',
            id: 'hierarchy.settings.control',
            panelId: 'hierarchy',
            control: 'hierarchy.settings',
            location: 'header/right',
            order: 40,
            enablement: 'panel.hierarchy.mounted',
          },
        ]),
        subscribeHierarchyPanelState(() => syncHierarchyContext(host)),
        onSelectionChange(() => syncHierarchyContext(host)),
        gateway.subscribe(() => syncHierarchyContext(host)),
      ];

      return () => {
        host.contextKeys.set('panel.hierarchy.mounted', false);
        for (const cleanup of cleanups.slice().reverse()) cleanup();
      };
    },
  };
}
