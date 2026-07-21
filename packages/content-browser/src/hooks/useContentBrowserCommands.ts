// useContentBrowserCommands — registers the Content Browser's host commands
// (`contentBrowser.*`) and pushes its live context keys (`panel.assets.*`).
//
// The set is stable at the ContentBrowser level; the hook is a pure wiring
// unit — no local state, no memos. Kept OUT of ContentBrowser.tsx so the two
// long useEffects don't dominate the reader's view of what the panel actually
// renders.

import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { broadcastAssetsChanged } from '@forgeax/editor-core';
import type { AppHost } from '@forgeax/interface/core/app-shell';
import type { TFunction } from '@forgeax/editor-core/i18n';
import { CREATABLE_ASSET_KINDS, type CreatableAssetSpec } from '../creatable-asset-kinds';
import type { CBViewMode2 } from '../view-mode';
import type { FilterAPI } from './useFilter';
import type { SortAPI } from './useSort';
import type { NavHistoryAPI } from './useNavHistory';

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
}

export function useContentBrowserCommands(deps: CBCommandsDeps): void {
  const {
    host, t, loading, viewMode, filter, sort, nav, favoritesOnly, thumbnailSize,
    reload, createFolderInCurrentPath, createAssetInCurrentPath, handleImport,
    clearKindFilters, setFavoritesOnly, setThumbnailSize,
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
      ...filter.filters.map((item, index) => {
        const kind = item.id.startsWith('kind:') ? item.id.slice('kind:'.length) : item.id;
        return {
          id: `contentBrowser.filter.${item.id}`,
          command: `contentBrowser.filter.kind.${kind}`,
          title: item.icon ? `${item.icon} ${item.label}` : item.label,
          checkable: true,
          activeWhen: `panel.assets.filter.${item.id}`,
          order: index,
        };
      }),
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
        execute: () => { broadcastAssetsChanged(); return { status: 'completed' as const }; },
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
      ...filter.filters.map((item) => {
        const kind = item.id.startsWith('kind:') ? item.id.slice('kind:'.length) : item.id;
        return host.commands.register({
          id: `contentBrowser.filter.kind.${kind}`,
          title: item.label,
          execute: () => { filter.toggleFilter(item.id); return { status: 'completed' as const }; },
        });
      }),
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
  }, [clearKindFilters, createAssetInCurrentPath, createFolderInCurrentPath, filter, handleImport, host, reload, sort, thumbnailSize, t, setFavoritesOnly, setThumbnailSize]);
}
