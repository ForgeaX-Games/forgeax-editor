// useContentBrowserCommands — registers the Content Browser's host commands
// (`contentBrowser.*`) and pushes its live context keys (`panel.assets.*`).
//
// The set is stable at the ContentBrowser level; the hook is a pure wiring
// unit — no local state, no memos. Kept OUT of ContentBrowser.tsx so the two
// long useEffects don't dominate the reader's view of what the panel actually
// renders.

import { useEffect, type Dispatch, type SetStateAction } from 'react';
import type { AppHost } from '@forgeax/interface/core/app-shell';
import type { TFunction } from '@forgeax/editor-core/i18n';
import { CREATABLE_ASSET_KINDS, type CreatableAssetSpec } from '../creatable-asset-kinds';
import type { CBViewMode2 } from '../view-mode';
import type { FilterAPI } from './useFilter';
import type { SortAPI } from './useSort';
import type { NavHistoryAPI } from './useNavHistory';
import { requestSaveAll } from '../save-all-bus';
import type { CBViewItem } from '../types';

export interface CBCommandsDeps {
  host: AppHost;
  t: TFunction;
  loading: boolean;
  viewMode: CBViewMode2;
  filter: FilterAPI;
  sort: SortAPI;
  nav: NavHistoryAPI;
  favoritesOnly: boolean;
  thumbnailSize: number;
  reload: () => void;
  createFolderInCurrentPath: () => void;
  createAssetInCurrentPath: (spec: CreatableAssetSpec) => void;
  handleImport: () => void;
  clearKindFilters: () => void;
  setFavoritesOnly: Dispatch<SetStateAction<boolean>>;
  setThumbnailSize: Dispatch<SetStateAction<number>>;
  getFocusedSourceTreeItem: () => CBViewItem | null;
  getFocusedGridItem: () => CBViewItem | null;
  renameItem: (item: CBViewItem) => void;
  deleteItem: (item: CBViewItem) => void;
  selectAllGridItems: () => void;
}

export interface ContentBrowserScopedCommandActions {
  readonly getSourceTreeItem: () => CBViewItem | null;
  readonly getGridItem: () => CBViewItem | null;
  readonly renameItem: (item: CBViewItem) => void;
  readonly deleteItem: (item: CBViewItem) => void;
  readonly selectAllGridItems: () => void;
}

export function registerContentBrowserScopedCommands(
  host: AppHost,
  actions: ContentBrowserScopedCommandActions,
): Array<() => void> {
  const deleteKeys = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)
    ? ['Delete', 'Backspace']
    : ['Delete'];
  return [
    host.keybindings.register({ keys: 'F2', commandId: 'contentBrowser.sourceTree.rename', scope: 'editor.contentBrowser.sourceTree' }),
    host.keybindings.register({ keys: deleteKeys, commandId: 'contentBrowser.sourceTree.delete', scope: 'editor.contentBrowser.sourceTree' }),
    host.keybindings.register({ keys: 'Mod+A', commandId: 'contentBrowser.sourceTree.selectAll', scope: 'editor.contentBrowser.sourceTree' }),
    host.keybindings.register({ keys: 'F2', commandId: 'contentBrowser.grid.rename', scope: 'editor.contentBrowser.grid' }),
    host.keybindings.register({ keys: deleteKeys, commandId: 'contentBrowser.grid.delete', scope: 'editor.contentBrowser.grid' }),
    host.keybindings.register({ keys: 'Mod+A', commandId: 'contentBrowser.grid.selectAll', scope: 'editor.contentBrowser.grid' }),
    host.commands.register({
      id: 'contentBrowser.sourceTree.rename',
      title: 'Content Browser Source Tree: Rename focused item',
      when: () => actions.getSourceTreeItem() !== null,
      execute: () => {
        const item = actions.getSourceTreeItem();
        if (item) actions.renameItem(item);
        return { status: 'completed' as const };
      },
    }),
    host.commands.register({
      id: 'contentBrowser.sourceTree.delete',
      title: 'Content Browser Source Tree: Delete focused item',
      when: () => actions.getSourceTreeItem() !== null,
      execute: () => {
        const item = actions.getSourceTreeItem();
        if (item) actions.deleteItem(item);
        return { status: 'completed' as const };
      },
    }),
    host.commands.register({
      id: 'contentBrowser.sourceTree.selectAll',
      title: 'Content Browser Source Tree: Select all',
      // Source-tree selection is a single navigation path. Claim Mod+A as
      // disabled so it cannot leak into the grid or Hierarchy.
      when: () => false,
      execute: () => ({ status: 'completed' as const }),
    }),
    host.commands.register({
      id: 'contentBrowser.grid.rename',
      title: 'Content Browser Grid: Rename focused item',
      when: () => actions.getGridItem() !== null,
      execute: () => {
        const item = actions.getGridItem();
        if (item) actions.renameItem(item);
        return { status: 'completed' as const };
      },
    }),
    host.commands.register({
      id: 'contentBrowser.grid.delete',
      title: 'Content Browser Grid: Delete focused item',
      when: () => actions.getGridItem() !== null,
      execute: () => {
        const item = actions.getGridItem();
        if (item) actions.deleteItem(item);
        return { status: 'completed' as const };
      },
    }),
    host.commands.register({
      id: 'contentBrowser.grid.selectAll',
      title: 'Content Browser Grid: Select all visible items',
      execute: () => {
        actions.selectAllGridItems();
        return { status: 'completed' as const };
      },
    }),
  ];
}

export function useContentBrowserCommands(deps: CBCommandsDeps): void {
  const {
    host, t, loading, viewMode, filter, sort, nav, favoritesOnly, thumbnailSize,
    reload, createFolderInCurrentPath, createAssetInCurrentPath, handleImport,
    clearKindFilters, setFavoritesOnly, setThumbnailSize,
    getFocusedSourceTreeItem, getFocusedGridItem, renameItem, deleteItem, selectAllGridItems,
  } = deps;

  useEffect(() => {
    host.contextKeys.set('panel.assets.mounted', true);
    return () => { host.contextKeys.set('panel.assets.mounted', false); };
  }, [host]);

  useEffect(() => {
    host.contextKeys.set('panel.assets.busy', loading);
    host.contextKeys.set('panel.assets.viewMode', viewMode);
    host.contextKeys.set('panel.assets.searchQuery', filter.searchQuery);
    host.contextKeys.set('panel.assets.sortKey', sort.sortState.key);
    host.contextKeys.set('panel.assets.sortDir', sort.sortState.dir);
    host.contextKeys.set('panel.assets.thumbnailSize', thumbnailSize);
    host.contextKeys.set('panel.assets.currentPath', nav.currentPath);
    host.contextKeys.set('panel.assets.favoritesOnly', favoritesOnly);
    host.contextKeys.set('panel.assets.filterCount', filter.activeFilterCount);
    for (const item of filter.filters) {
      host.contextKeys.set(`panel.assets.filter.${item.id}`, item.active);
    }
    const activeFilters = filter.filters.filter(item => item.active);
    host.contextKeys.set(
      'panel.assets.filter.label',
      activeFilters.length === 0
        ? t('editor.contentBrowser.actions.filterAll')
        : activeFilters.length === 1
          ? activeFilters[0]!.label
          : t('editor.contentBrowser.actions.filterByType'),
    );
    host.contextKeys.set('panel.assets.filter.menuItems', [
      ...filter.filters.map((item, index) => ({
        id: `contentBrowser.filter.${item.id}`,
        command: `contentBrowser.filter.family.${item.family}`,
        title: item.label,
        icon: item.icon,
        checkable: true,
        activeWhen: `panel.assets.filter.${item.id}`,
        order: index,
      })),
      { kind: 'separator' as const, id: 'contentBrowser.filter.separator', order: 10000 },
      {
        id: 'contentBrowser.filter.clear',
        command: 'contentBrowser.filter.clear',
        title: t('editor.contentBrowser.actions.clearFilters'),
        icon: 'RotateCcw',
        tone: 'reset',
        order: 10001,
      },
    ]);
  }, [favoritesOnly, filter.activeFilterCount, filter.filters, filter.searchQuery, host, loading, nav.currentPath, sort.sortState.dir, sort.sortState.key, thumbnailSize, viewMode, t]);

  useEffect(() => {
    const cleanups = [
      ...registerContentBrowserScopedCommands(host, {
        getSourceTreeItem: getFocusedSourceTreeItem,
        getGridItem: getFocusedGridItem,
        renameItem,
        deleteItem,
        selectAllGridItems,
      }),
      host.commands.register({
        id: 'contentBrowser.refresh',
        title: t('editor.assets.reloadTitle'),
        execute: () => { reload(); return { status: 'completed' as const }; },
      }),
      host.commands.register({
        id: 'contentBrowser.createFolder',
        title: t('editor.contentBrowser.actions.createFolder'),
        execute: () => { createFolderInCurrentPath(); return { status: 'completed' as const }; },
      }),
      ...CREATABLE_ASSET_KINDS.map((spec) => host.commands.register({
        id: `contentBrowser.createAsset.${spec.kind}`,
        title: t('editor.contentBrowser.actions.createAsset', { label: spec.label }),
        execute: () => { createAssetInCurrentPath(spec); return { status: 'completed' as const }; },
      })),
      host.commands.register({
        id: 'contentBrowser.import',
        title: t('editor.contentBrowser.actions.import'),
        execute: () => { handleImport(); return { status: 'completed' as const }; },
      }),
      host.commands.register({
        id: 'contentBrowser.saveAll',
        title: t('editor.contentBrowser.actions.saveAll'),
        execute: () => { void requestSaveAll(); return { status: 'completed' as const }; },
      }),
      host.commands.register({
        id: 'contentBrowser.toggleFavoritesOnly',
        title: t('editor.contentBrowser.actions.favorite'),
        execute: () => {
          setFavoritesOnly(current => !current);
          return { status: 'completed' as const };
        },
      }),
      host.commands.register({
        id: 'contentBrowser.filter.clear',
        title: t('editor.contentBrowser.actions.clearFilters'),
        execute: () => { clearKindFilters(); return { status: 'completed' as const }; },
      }),
      host.commands.register({
        id: 'contentBrowser.search.set',
        title: t('editor.contentBrowser.actions.searchAria'),
        execute: (args: unknown) => {
          const value = typeof (args as { value?: unknown } | undefined)?.value === 'string'
            ? (args as { value: string }).value
            : '';
          filter.setSearchQuery(value);
          return { status: 'completed' as const };
        },
      }),
      host.commands.register({
        id: 'contentBrowser.search.clear',
        title: t('editor.contentBrowser.actions.clearSearch'),
        execute: () => { filter.setSearchQuery(''); return { status: 'completed' as const }; },
      }),
      ...filter.filters.map((item) => host.commands.register({
        id: `contentBrowser.filter.family.${item.family}`,
        title: item.label,
        execute: () => { filter.toggleFilter(item.id); return { status: 'completed' as const }; },
      })),
      host.commands.register({
        id: 'contentBrowser.sort.set',
        title: t('editor.contentBrowser.actions.sortDirection'),
        execute: (args: unknown) => {
          const key = (args as { key?: unknown } | undefined)?.key;
          if (key === 'name' || key === 'kind' || key === 'packModifiedAt' || key === 'estimatedSize') {
            sort.setSortKey(key);
          }
          return { status: 'completed' as const };
        },
      }),
      host.commands.register({
        id: 'contentBrowser.sort.name',
        title: t('editor.contentBrowser.sort.name'),
        execute: () => { sort.setSortKey('name'); return { status: 'completed' as const }; },
      }),
      host.commands.register({
        id: 'contentBrowser.sort.kind',
        title: t('editor.contentBrowser.sort.kind'),
        execute: () => { sort.setSortKey('kind'); return { status: 'completed' as const }; },
      }),
      host.commands.register({
        id: 'contentBrowser.sort.modified',
        title: t('editor.contentBrowser.sort.modified'),
        execute: () => { sort.setSortKey('packModifiedAt'); return { status: 'completed' as const }; },
      }),
      host.commands.register({
        id: 'contentBrowser.sort.size',
        title: t('editor.contentBrowser.sort.size'),
        execute: () => { sort.setSortKey('estimatedSize'); return { status: 'completed' as const }; },
      }),
      host.commands.register({
        id: 'contentBrowser.sort.toggleDir',
        title: t('editor.contentBrowser.actions.sortDirection'),
        execute: () => { sort.toggleDir(); return { status: 'completed' as const }; },
      }),
      host.commands.register({
        id: 'contentBrowser.thumbnailSize.set',
        title: t('editor.contentBrowser.actions.thumbnailSize', { size: thumbnailSize }),
        execute: (args: unknown) => {
          const value = Number((args as { value?: unknown } | undefined)?.value);
          if (Number.isFinite(value)) setThumbnailSize(Math.max(48, Math.min(200, value)));
          return { status: 'completed' as const };
        },
      }),
    ];
    return () => { for (const cleanup of cleanups.slice().reverse()) cleanup(); };
  }, [clearKindFilters, createAssetInCurrentPath, createFolderInCurrentPath, deleteItem, filter, getFocusedGridItem, getFocusedSourceTreeItem, handleImport, host, reload, renameItem, selectAllGridItems, sort, thumbnailSize, t, setFavoritesOnly, setThumbnailSize]);
}
