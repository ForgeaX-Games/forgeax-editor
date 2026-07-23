import { useEffect, useReducer, type ChangeEvent, type ReactNode } from 'react';
import { useHost } from '@forgeax/interface/core/app-shell';
import { useTranslation } from '@forgeax/editor-core/i18n';

function usePanelContextKey<T>(key: string): T | undefined {
  const host = useHost();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const cleanup = host.contextKeys.onChange(key, () => bump());
    return () => { void cleanup(); };
  }, [host, key]);
  return host.contextKeys.get<T>(key);
}

function executeContentBrowserCommand(host: ReturnType<typeof useHost>, command: string, args?: unknown): void {
  void host.commands.execute(command, args).catch((err: unknown) => {
    console.error(`[content-browser-panel] command "${command}" failed`, err);
  });
}

function ContentBrowserSearchControl(): ReactNode {
  const host = useHost();
  const { t } = useTranslation();
  const value = usePanelContextKey<string>('panel.assets.searchQuery') ?? '';
  return (
    <div className="fx-panel-search-control">
      <input
        className="fx-panel-search-input"
        type="search"
        value={value}
        placeholder={t('editor.contentBrowser.actions.searchPlaceholder')}
        aria-label={t('editor.contentBrowser.actions.searchAria')}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          executeContentBrowserCommand(host, 'contentBrowser.search.set', { value: event.target.value });
        }}
      />
    </div>
  );
}

export function useContentBrowserPanelContributions(): void {
  const host = useHost();
  const { t, i18n } = useTranslation();

  // Re-contribute when locale changes so header labels update. `t` is a stable
  // module-level function; `i18n.language` is the signal that locale changed.
  useEffect(() => {
    const owner = 'content-browser';
    const cleanupActions = host.panelActions.contribute(owner, [
      {
        kind: 'menu',
        id: 'contentBrowser.create.menu',
        panelId: 'assets',
        title: t('editor.contentBrowser.actions.create'),
        label: t('editor.contentBrowser.actions.create'),
        icon: 'Plus',
        location: 'header/left',
        order: 10,
        enablement: 'panel.assets.mounted',
        items: [
          {
            id: 'contentBrowser.create.folder',
            command: 'contentBrowser.createFolder',
            title: t('editor.contentBrowser.actions.createFolder'),
            icon: 'FolderPlus',
            order: 10,
          },
          {
            id: 'contentBrowser.create.scene',
            command: 'contentBrowser.createAsset.scene',
            title: t('editor.contentBrowser.fileKinds.scene'),
            // Panel-action menus resolve lucide icons by PascalCase name (a
            // different resolver than content-browser-icons' kebab map); scene's
            // canonical icon is the clapperboard, matching its file/asset icon.
            icon: 'Clapperboard',
            order: 20,
          },
        ],
      },
      {
        id: 'contentBrowser.import.action',
        panelId: 'assets',
        command: 'contentBrowser.import',
        title: t('editor.contentBrowser.actions.import'),
        label: t('editor.contentBrowser.actions.import'),
        icon: 'Download',
        location: 'header/left',
        order: 20,
        enablement: 'panel.assets.mounted',
      },
      {
        id: 'contentBrowser.saveAll.action',
        panelId: 'assets',
        command: 'contentBrowser.saveAll',
        title: t('editor.contentBrowser.actions.saveAll'),
        label: t('editor.contentBrowser.actions.saveAll'),
        icon: 'Save',
        location: 'header/left',
        order: 30,
        enablement: 'panel.assets.mounted',
      },
      {
        id: 'contentBrowser.favorite.action',
        panelId: 'assets',
        command: 'contentBrowser.toggleFavoritesOnly',
        title: t('editor.contentBrowser.actions.favorite'),
        icon: 'Star',
        location: 'header/right',
        order: 10,
        enablement: 'panel.assets.mounted',
        activeWhen: 'panel.assets.favoritesOnly',
      },
      {
        kind: 'menu',
        id: 'contentBrowser.filter.menu',
        panelId: 'assets',
        title: t('editor.contentBrowser.actions.filterByType'),
        label: t('editor.contentBrowser.actions.filterAll'),
        labelContextKey: 'panel.assets.filter.label',
        icon: 'Filter',
        location: 'header/right',
        order: 20,
        enablement: 'panel.assets.mounted',
        highlightWhen: 'panel.assets.filterCount != 0',
        itemsContextKey: 'panel.assets.filter.menuItems',
        items: [],
      },
      {
        kind: 'control',
        id: 'contentBrowser.search.control',
        panelId: 'assets',
        control: 'contentBrowser.search',
        location: 'header/right',
        order: 30,
        enablement: 'panel.assets.mounted',
      },
    ]);
    const cleanupControls = host.panelControls.contribute(owner, [
      { id: 'contentBrowser.search', render: () => <ContentBrowserSearchControl /> },
    ]);

    return () => {
      void cleanupControls();
      void cleanupActions();
    };
  }, [host, i18n.language, t]);
}
