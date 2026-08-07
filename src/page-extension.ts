import type { ReactNode } from 'react';
import type { AppExtension, AppHost } from '@forgeax/interface/core/app-shell/types';
import type {
  ActivityRegistration,
  PageController,
  PageMenuItem,
  PagePanelPlacement,
  PageTypeRegistration,
  PanelTypeRegistration,
  ResourceEditorRegistration,
} from '@forgeax/interface/core/page-platform';
import { registerPageDirtyProbe } from '@forgeax/interface/core/page-platform';
import {
  configureEditorPageNavigation,
  gateway,
  getActiveScenePackPath,
  getSceneFile,
  getSceneList,
  hasPendingDiskSave,
  isMiStagingDirty,
  onSceneListChange,
  registerActivePageSaveHandler,
  subscribeMiStaging,
  type SelectedAsset,
} from '@forgeax/editor-core';
import { t } from '@forgeax/editor-core/i18n';
import {
  DEFAULT_ASSET_EDITOR_DOCK_LAYOUT,
  DEFAULT_EDITOR_DOCK_LAYOUT,
  DEFAULT_MESH_EDITOR_DOCK_LAYOUT,
  DEFAULT_MI_EDITOR_DOCK_LAYOUT,
} from './default-dock-layout';
import {
  createMaterialInstancePageController,
  getMiPageController,
} from './mi-page-controller';

const OWNER = '@forgeax/editor';
const pageId = (id: string) => `${OWNER}#page/${id}` as PageTypeRegistration['id'];
const panelId = (id: string) => `${OWNER}#panel/${id}` as PanelTypeRegistration['id'];
const activityId = (id: string) => `${OWNER}#activity/${id}` as ActivityRegistration['id'];
const editorId = (id: string) => `${OWNER}#resource-editor/${id}` as ResourceEditorRegistration['id'];

const LEVEL_PAGE = pageId('level');
const ASSET_PAGE = pageId('asset');
const MESH_PAGE = pageId('mesh');
const MATERIAL_PAGE = pageId('material');
const MATERIAL_INSTANCE_PAGE = pageId('material-instance');

// `info` / `checkpoints` / `events` are interface-owned footer chrome that
// default into the merged bottom EDGE group (see default-dock-layout.ts
// edgeGroups). They must be page-scope members here or DockRegion's isMember
// (which gates every id by the active page's panel set) filters them out of the
// footer strip — the "only Info shows" bug. Their bodies render via the
// interface BASE panel components (which override the page runtime for these
// stable ids), so no editor panelType component is needed.
//
// ep:settings is editor CHROME (viewport preferences), not a document panel —
// it must be a member of every editor page's closed panel domain so the TopBar
// gear's panel:open never dies on DockRegion's pagePanelIds gate, regardless
// of which page is active. It is deliberately absent from every default dock
// layout: the panel opens on demand (gear / Window menu), never on boot.
const LEVEL_PANELS = ['ep:hierarchy', 'ep:inspector', 'viewport', 'info', 'checkpoints', 'events', 'ep:assets', 'ep:history', 'ep:capabilities', 'ep:settings'];
const ASSET_PANELS = ['ep:asset-properties', 'ep:asset-overview', 'ep:settings'];
const MESH_PANELS = [...ASSET_PANELS, 'ep:mesh-slots'];
const MATERIAL_INSTANCE_PANELS = ['ep:mi-preview', 'ep:mi-properties', 'ep:settings'];

function placements(ids: readonly string[]): PagePanelPlacement[] {
  return ids.map((id) => ({ id, panelTypeId: panelId(id.replace(/^ep:/u, '')) }));
}

// Current scene name from editor-core's scene manifest (the in-realm SSOT), used
// as the Level tab's live title. `getSceneFile()` is the bound scene id; the
// matching manifest entry carries its human name.
function currentSceneName(): string | undefined {
  const id = getSceneFile();
  if (!id) return undefined;
  return getSceneList().find((entry) => entry.id === id)?.name ?? id;
}

// Late-bound host for menu actions that dispatch a command (set in setup; the
// editor extension is a single-realm singleton, like editor-core's own state).
// Only "reveal" needs it; copy/reference are host-free.
let hostRef: AppHost | undefined;

// Menu groups (order = divider layout): 'file' = path actions (copy / reveal);
// 'actions' = the LAST group, holding save + reference-to-chat together (per the
// interaction spec). copy/reveal need no host; reveal fires the shared
// `file.reveal` command; reference goes through the public app.chat command.
// `| undefined` fields keep exactOptionalPropertyTypes callers simple.

function pathMenuItems(path: string | undefined): PageMenuItem[] {
  if (!path) return [];
  return [
    {
      id: 'copy-path', label: t('editor.pageMenu.copyPath'), icon: 'copy', group: 'file',
      run: () => { void navigator.clipboard?.writeText(path).catch(() => {}); },
    },
    {
      id: 'reveal', label: t('editor.pageMenu.revealInExplorer'), icon: 'folder-search', group: 'file',
      run: () => { void hostRef?.commands.execute('file.reveal', { path }).catch(() => {}); },
    },
  ];
}

function referenceMenuItem(opts: {
  guid?: string | null | undefined;
  name?: string | undefined;
  kind?: string | undefined;
  path?: string | undefined;
}): PageMenuItem[] {
  if (!opts.guid) return [];
  const guid = opts.guid;
  return [{
    id: 'reference', label: t('editor.pageMenu.referenceToChat'), icon: 'at-sign', group: 'actions',
    run: () => {
      void hostRef?.commands.execute('app.chat.referenceAsset', {
        guid,
        ...(opts.name ? { name: opts.name } : {}),
        ...(opts.kind ? { assetKind: opts.kind } : {}),
        ...(opts.path ? { packPath: opts.path } : {}),
      }).catch(() => {});
    },
  }];
}

// Save = the human Ctrl+S path (saveDocToDisk gateway op), enabled only while
// the scene has pending disk changes (hasPendingDiskSave — the toolbar dirty
// read); disabled+greyed when clean. Shares the last 'actions' group with
// reference-to-chat.
function saveSceneItem(): PageMenuItem {
  return {
    id: 'save', label: t('editor.pageMenu.save'), icon: 'save', group: 'actions',
    disabled: !hasPendingDiskSave(),
    run: () => {
      try { gateway.dispatch({ kind: 'saveDocToDisk', requestId: crypto.randomUUID() }, 'human'); } catch { /* gateway locked */ }
    },
  };
}

// The Level tab tracks the current scene the way VSCode's EditorInput tracks its
// name: `getTitle()` reads the value now, `subscribeTitle()` fires on scene
// switch/create/delete (editor-core `onSceneListChange`) — event-driven, no poll.
// Menu: path actions on the current scene pack, then save + reference last.
const levelController = (): PageController => ({
  prepareClose: () => ({ status: 'ready' }),
  dispose: () => undefined,
  getTitle: () => currentSceneName(),
  subscribeTitle: (listener) => onSceneListChange(listener),
  getContextMenuItems: () => {
    const id = getSceneFile();
    const entry = id ? getSceneList().find((s) => s.id === id) : undefined;
    const path = getActiveScenePackPath() ?? undefined;
    return [
      ...pathMenuItems(path),
      saveSceneItem(),
      ...referenceMenuItem({ guid: entry?.guid ?? null, name: entry?.name ?? id ?? undefined, kind: 'scene', path }),
    ];
  },
});

// Resource pages (Asset / Mesh / Material) get the file actions off their bound
// resource descriptor — the concrete file behind the tab; reference last.
const fileController: PageTypeRegistration['createController'] = (context) => {
  const resource = context.resource;
  const path = resource?.displayPath ?? resource?.uri;
  return {
    prepareClose: () => ({ status: 'ready' }),
    dispose: () => undefined,
    getContextMenuItems: () => [
      ...pathMenuItems(path),
      ...referenceMenuItem({
        guid: resource?.canonicalId ?? null,
        name: path ? path.split('/').at(-1) : undefined,
        kind: resource?.kind,
        path,
      }),
    ],
  };
};

function page(
  id: PageTypeRegistration['id'],
  title: string,
  cardinality: PageTypeRegistration['cardinality'],
  layout: PageTypeRegistration['layout'],
  ids: readonly string[],
  createController?: PageTypeRegistration['createController'],
): PageTypeRegistration {
  return {
    id,
    title,
    cardinality,
    restorePolicy: 'project',
    closable: id !== LEVEL_PAGE,
    layoutVersion: 1,
    layout,
    panels: placements(ids),
    ...(createController ? { createController } : {}),
  };
}

function pageForAsset(asset: SelectedAsset): PageTypeRegistration['id'] {
  if (asset.kind === 'mesh') return MESH_PAGE;
  if (asset.kind === 'material-instance') return MATERIAL_INSTANCE_PAGE;
  if (asset.kind === 'material') return MATERIAL_PAGE;
  return ASSET_PAGE;
}

export function createEditorPageExtension(
  renderPanel: (id: string) => ReactNode,
): AppExtension {
  const allPanelIds = [...new Set([...LEVEL_PANELS, ...MESH_PANELS, ...MATERIAL_INSTANCE_PANELS])];
  return {
    id: OWNER,
    version: '2.0.0',
    requires: ['pages'],
    contributes: {
      panelTypes: allPanelIds.map((id): PanelTypeRegistration => ({
        id: panelId(id.replace(/^ep:/u, '')),
        runtime: { kind: 'inline', render: () => renderPanel(id.replace(/^ep:/u, '')) },
      })),
      pages: [
        page(LEVEL_PAGE, 'Level', 'singleton', DEFAULT_EDITOR_DOCK_LAYOUT, LEVEL_PANELS, levelController),
        page(ASSET_PAGE, 'Asset', 'resource', DEFAULT_ASSET_EDITOR_DOCK_LAYOUT, ASSET_PANELS, fileController),
        page(MESH_PAGE, 'Mesh', 'resource', DEFAULT_MESH_EDITOR_DOCK_LAYOUT, MESH_PANELS, fileController),
        page(MATERIAL_PAGE, 'Material', 'resource', DEFAULT_ASSET_EDITOR_DOCK_LAYOUT, ASSET_PANELS, fileController),
        {
          ...page(
            MATERIAL_INSTANCE_PAGE,
            'Material Instance',
            'resource',
            DEFAULT_MI_EDITOR_DOCK_LAYOUT,
            MATERIAL_INSTANCE_PANELS,
          ),
          createController: createMaterialInstancePageController,
        },
      ],
      activities: [{
        id: activityId('editor'),
        title: 'Editor',
        category: 'builtin',
        order: 0,
        pageTypeId: LEVEL_PAGE,
      }],
      resourceEditors: [
        { id: editorId('mesh'), selector: { kinds: ['mesh'] }, pageTypeId: MESH_PAGE, priority: 'default', sourceLayer: 'builtin' },
        { id: editorId('material'), selector: { kinds: ['material'] }, pageTypeId: MATERIAL_PAGE, priority: 'default', sourceLayer: 'builtin' },
        {
          id: editorId('material-instance'),
          selector: { kinds: ['material-instance'] },
          pageTypeId: MATERIAL_INSTANCE_PAGE,
          priority: 'default',
          sourceLayer: 'builtin',
        },
        {
          id: editorId('asset'),
          selector: {
            kinds: ['texture', 'cube-texture', 'sampler', 'scene', 'shader', 'skeleton', 'skin', 'animation-clip', 'audio', 'font', 'render-pipeline', 'tileset'],
          },
          pageTypeId: ASSET_PAGE,
          priority: 'default',
          sourceLayer: 'builtin',
        },
      ],
    },
    setup(ctx) {
      hostRef = ctx.host;
      const activeAsset = (): SelectedAsset | null => {
        const snapshot = ctx.host.pages.getSnapshot();
        const instance = snapshot.instances.find((candidate) => candidate.encodedKey === snapshot.activeKey);
        const value = instance?.resource?.metadata?.asset;
        return value && typeof value === 'object' ? value as SelectedAsset : null;
      };
      const resetNavigation = configureEditorPageNavigation({
        async openAsset(asset) {
          await ctx.host.pages.open({
            typeId: pageForAsset(asset),
            resource: {
              canonicalId: asset.guid,
              uri: `forgeax-asset://${asset.guid}`,
              displayPath: asset.name,
              kind: asset.kind,
              metadata: { asset },
            },
          });
        },
        getActiveAsset: activeAsset,
        subscribe: ctx.host.pages.subscribe,
      });
      const resetDirtyProbe = registerPageDirtyProbe({
        isDirty: (page) => {
          if (page.typeId !== MATERIAL_INSTANCE_PAGE) return false;
          const guid = page.resource?.canonicalId;
          return typeof guid === 'string' && isMiStagingDirty(guid);
        },
        subscribe: subscribeMiStaging,
      });
      const resetActiveSave = registerActivePageSaveHandler(() => {
        const snapshot = ctx.host.pages.getSnapshot();
        if (!snapshot.activeKey) return false;
        const instance = snapshot.instances.find((candidate) => candidate.encodedKey === snapshot.activeKey);
        if (!instance || instance.typeId !== MATERIAL_INSTANCE_PAGE) return false;
        const controller = getMiPageController(snapshot.activeKey);
        if (!controller?.save) return false;
        void controller.save();
        return true;
      });
      void ctx.host.pages.open({ typeId: LEVEL_PAGE });
      return () => {
        resetActiveSave();
        resetDirtyProbe();
        resetNavigation();
      };
    },
  };
}
