import { createElement, type ReactNode } from 'react';
import type { AppExtension, AppHost, ContentBrowserRevealTarget } from '@forgeax/interface/core/app-shell/types';
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
  getInputMapStaging,
  getSceneFile,
  getSceneList,
  hasPendingDiskSave,
  isMaterialStagingDirty,
  isMiStagingDirty,
  isInputMapStagingDirty,
  onSceneListChange,
  registerActivePageSaveHandler,
  subscribeAssetsChanged,
  subscribeMaterialStaging,
  subscribeMiStaging,
  subscribeInputMapStaging,
  type SelectedAsset,
} from '@forgeax/editor-core';
import { t } from '@forgeax/editor-core/i18n';
import {
  DEFAULT_ASSET_EDITOR_DOCK_LAYOUT,
  DEFAULT_EDITOR_DOCK_LAYOUT,
  DEFAULT_MATERIAL_EDITOR_DOCK_LAYOUT,
  DEFAULT_TEXTURE_EDITOR_DOCK_LAYOUT,
  DEFAULT_MESH_EDITOR_DOCK_LAYOUT,
  DEFAULT_MI_EDITOR_DOCK_LAYOUT,
  DEFAULT_INPUT_MAP_EDITOR_DOCK_LAYOUT,
  DEFAULT_VFX_EDITOR_DOCK_LAYOUT,
  DEFAULT_OPERATIONS_PAGE_DOCK_LAYOUT,
} from './default-dock-layout';
import {
  createMaterialPageController,
  invokeMaterialPageSave,
  resolveProjectMaterialRevision,
  trySaveDirtyMaterialStaging,
} from './page-controllers/material-page-controller';
import {
  createMaterialInstancePageController,
  getMiPageController,
} from './page-controllers/mi-page-controller';
import {
  createInputMapPageController,
  getInputMapPageController,
} from './page-controllers/input-map-page-controller';
import { applyToolClientRunEvent, createToolClientProjection, type ToolClientRunEvent } from './runtime/tool-client-events';
import { createAuthoringOperationsProjection, type AuthoringOperationsProjection } from './runtime/tool-client-operations';
import type { AuthoringToolClientTransport } from './runtime/tool-client-transport';
import { OperationsPage, installOperationsObserverSource } from '@forgeax/editor-panels';

const OWNER = '@forgeax/editor';
export const EDITOR_OPERATIONS_OBSERVER_CAPABILITY = 'operations-observer' as const;
const pageId = (id: string) => `${OWNER}#page/${id}` as PageTypeRegistration['id'];
const panelId = (id: string) => `${OWNER}#panel/${id}` as PanelTypeRegistration['id'];
const activityId = (id: string) => `${OWNER}#activity/${id}` as ActivityRegistration['id'];
const editorId = (id: string) => `${OWNER}#resource-editor/${id}` as ResourceEditorRegistration['id'];

/**
 * UI pages receive authoring capabilities from the host ToolClient. This
 * factory only projects the typed transport; it does not execute an operation
 * or retain a Project/RunJournal/registry in the page realm.
 */
export function createPageAuthoringOperationsProjection(
  transport?: AuthoringToolClientTransport,
): AuthoringOperationsProjection {
  return createAuthoringOperationsProjection(transport);
}

const LEVEL_PAGE = pageId('level');
const ASSET_PAGE = pageId('asset');
const MESH_PAGE = pageId('mesh');
const TEXTURE_PAGE = pageId('texture');
const MATERIAL_PAGE = pageId('material');
const MATERIAL_INSTANCE_PAGE = pageId('material-instance');
const INPUT_MAP_PAGE = pageId('input-map');
const VFX_PAGE = pageId('vfx');
const OPERATIONS_PAGE = pageId('operations');

/** Public carrier location owned by the editor page contribution. */
export const EDITOR_LEVEL_PAGE_ID = LEVEL_PAGE;
export const EDITOR_VIEWPORT_PANEL_ID = 'ep:viewport' as const;
export const EDITOR_PAGE_CARRIER_DESCRIPTOR = Object.freeze({
  pageTypeId: EDITOR_LEVEL_PAGE_ID,
  viewportPanelId: EDITOR_VIEWPORT_PANEL_ID,
  visible: true as const,
  gameplay: true as const,
});

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
const ASSET_PANELS = ['ep:asset-properties', 'ep:settings'];
const MESH_PANELS = ['ep:mesh-preview', ...ASSET_PANELS, 'ep:mesh-slots'];
const TEXTURE_PANELS = ['ep:texture-preview', ...ASSET_PANELS];
const MATERIAL_PANELS = ['ep:mat-preview', ...ASSET_PANELS];
const MATERIAL_INSTANCE_PANELS = ['ep:mi-preview', 'ep:mi-properties', 'ep:settings'];
const INPUT_MAP_PANELS = ['ep:input-map-properties', 'ep:settings'];
const VFX_PANELS = ['ep:vfx-system', 'ep:vfx-preview', 'ep:vfx-timeline', 'ep:vfx-details', 'ep:vfx-diagnostics', 'ep:settings'];
const OPERATIONS_PANELS = ['ep:operations-page'];

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

// Late-bound host for menu actions that dispatch a command / emit a bus event
// (set in setup; the editor extension is a single-realm singleton, like
// editor-core's own state). "locate-in-cb" and "reference" need it; copy is
// host-free.
let hostRef: AppHost | undefined;

// Menu groups (order = divider layout): 'file' = path actions (copy path +
// locate in content browser); 'actions' = the LAST group, holding save +
// reference-to-chat together (per the interaction spec). copy needs no host;
// locate emits the `content-browser:reveal` bus event; reference goes through
// the public app.chat command. `| undefined` fields keep
// exactOptionalPropertyTypes callers simple.

function pathMenuItems(path: string | undefined): PageMenuItem[] {
  if (!path) return [];
  return [
    {
      id: 'copy-path', label: t('editor.pageMenu.copyPath'), icon: 'copy', group: 'file',
      run: () => { void navigator.clipboard?.writeText(path).catch(() => {}); },
    },
  ];
}

// "Locate in Content Browser" — pure mechanism communication: this file NEVER
// imports the content-browser package. It (1) reveals the global Content Browser
// footer panel via an interface command, then (2) emits the neutral
// `content-browser:reveal` bus event. A mounted Content Browser (a global footer
// service, present on every Page) resolves the target and performs the
// navigation/selection through its own gateway door. Decoupled both ways.
function revealTargetFor(opts: {
  guid?: string | null | undefined;
  path?: string | undefined;
  kind?: string | undefined;
  name?: string | undefined;
}): ContentBrowserRevealTarget {
  if (opts.guid) {
    return {
      guid: opts.guid,
      ...(opts.path ? { packPath: opts.path } : {}),
      ...(opts.kind ? { assetKind: opts.kind } : {}),
      ...(opts.name ? { name: opts.name } : {}),
    };
  }
  return opts.path ? { path: opts.path, pathKind: 'file' } : {};
}

async function revealInContentBrowser(target: ContentBrowserRevealTarget): Promise<void> {
  const host = hostRef;
  if (!host || (!target.guid && !target.path)) return;
  // The Content Browser is global footer chrome now — mounted on every Page — so
  // there is no need to switch to the Level page first. 1) Reveal the CB panel
  // wherever it lives (footer edge drawer / a grid tab the user dragged it to).
  // 2) Hand the locate instruction to the Content Browser over the neutral bus.
  // The double rAF gives a freshly-expanded footer drawer a frame to mount +
  // subscribe before the target arrives.
  try { await host.commands.execute('app.panel.reveal', { id: 'ep:assets' }); } catch { /* noop */ }
  requestAnimationFrame(() => requestAnimationFrame(() => host.bus.emit('content-browser:reveal', { target })));
}

function locateMenuItems(target: ContentBrowserRevealTarget): PageMenuItem[] {
  if (!target.guid && !target.path) return [];
  return [{
    id: 'locate-in-cb', label: t('editor.pageMenu.locateInContentBrowser'), icon: 'crosshair', group: 'file',
    run: () => { void revealInContentBrowser(target); },
  }];
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
      ...locateMenuItems(revealTargetFor({ guid: entry?.guid ?? null, path, kind: 'scene', name: entry?.name ?? id ?? undefined })),
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
      ...locateMenuItems(revealTargetFor({
        guid: resource?.canonicalId ?? null,
        path,
        kind: resource?.kind,
        name: path ? path.split('/').at(-1) : undefined,
      })),
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
  // Bump when the page's panel set / default arrangement changes: persisted
  // page-layout snapshots are keyed on (pageTypeId, layoutVersion) and a
  // mismatch discards the stale snapshot so the new default applies. Without
  // a bump, a pre-change snapshot is silently accepted as long as ANY panel
  // of the domain still mounts (hasMountedPagePlacement), and users never
  // see newly added panels — the "mat-preview never appears" bug.
  layoutVersion = 1,
): PageTypeRegistration {
  return {
    id,
    title,
    cardinality,
    restorePolicy: 'project',
    closable: id !== LEVEL_PAGE,
    layoutVersion,
    layout,
    panels: placements(ids),
    ...(createController ? { createController } : {}),
  };
}

export function createEditorPageExtension(
  renderPanel: (id: string) => ReactNode,
): AppExtension {
  const allPanelIds = [...new Set([
    ...LEVEL_PANELS,
    ...MESH_PANELS,
    ...TEXTURE_PANELS,
    ...MATERIAL_PANELS,
    ...MATERIAL_INSTANCE_PANELS,
    ...INPUT_MAP_PANELS,
    ...VFX_PANELS,
    ...OPERATIONS_PANELS,
  ])];
  return {
    id: OWNER,
    version: '2.0.0',
    requires: ['pages'],
    // `host.extend` is guarded by the manifest. Without this declaration the
    // observer setup is rejected even though the capability is otherwise
    // disposable and owner-scoped.
    provides: [EDITOR_OPERATIONS_OBSERVER_CAPABILITY],
    contributes: {
      panelTypes: allPanelIds.map((id): PanelTypeRegistration => ({
        id: panelId(id.replace(/^ep:/u, '')),
        runtime: {
          kind: 'inline',
          render: () => id === 'ep:operations-page' ? createElement(OperationsPage) : renderPanel(id.replace(/^ep:/u, '')),
        },
      })),
      pages: [
        page(LEVEL_PAGE, 'Level', 'singleton', DEFAULT_EDITOR_DOCK_LAYOUT, LEVEL_PANELS, levelController),
        page(ASSET_PAGE, 'Asset', 'resource', DEFAULT_ASSET_EDITOR_DOCK_LAYOUT, ASSET_PANELS, fileController),
        page(MESH_PAGE, 'Mesh', 'resource', DEFAULT_MESH_EDITOR_DOCK_LAYOUT, MESH_PANELS, fileController, 2),
        page(TEXTURE_PAGE, 'Texture', 'resource', DEFAULT_TEXTURE_EDITOR_DOCK_LAYOUT, TEXTURE_PANELS, fileController, 1),
        {
          ...page(
            MATERIAL_PAGE,
            'Material',
            'resource',
            DEFAULT_MATERIAL_EDITOR_DOCK_LAYOUT,
            MATERIAL_PANELS,
            undefined,
            2,
          ),
          createController: createMaterialPageController,
        },
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
        {
          ...page(
            INPUT_MAP_PAGE,
            'Input Map',
            'resource',
            DEFAULT_INPUT_MAP_EDITOR_DOCK_LAYOUT,
            INPUT_MAP_PANELS,
          ),
          createController: createInputMapPageController,
        },
        page(VFX_PAGE, 'VFX', 'resource', DEFAULT_VFX_EDITOR_DOCK_LAYOUT, VFX_PANELS, fileController),
        page(OPERATIONS_PAGE, 'AI Operations', 'singleton', DEFAULT_OPERATIONS_PAGE_DOCK_LAYOUT, OPERATIONS_PANELS),
      ],
      activities: [{
        id: activityId('editor'),
        title: 'Editor',
        titleI18n: { zh: '\u7f16\u8f91\u5668', en: 'Editor', ja: '\u30a8\u30c7\u30a3\u30bf\u30fc' },
        category: 'builtin',
        sourceLayer: 'builtin',
        order: 0,
        pageTypeId: LEVEL_PAGE,
      }, {
        id: activityId('operations'),
        title: 'AI Operations',
        category: 'builtin',
        sourceLayer: 'builtin',
        order: 1,
        pageTypeId: OPERATIONS_PAGE,
      }],
      resourceEditors: [
        { id: editorId('mesh'), selector: { kinds: ['mesh'] }, pageTypeId: MESH_PAGE, priority: 'default', sourceLayer: 'builtin' },
        {
          id: editorId('texture'),
          selector: { kinds: ['texture', 'image'] },
          pageTypeId: TEXTURE_PAGE,
          priority: 'default',
          sourceLayer: 'builtin',
        },
        { id: editorId('material'), selector: { kinds: ['material'] }, pageTypeId: MATERIAL_PAGE, priority: 'default', sourceLayer: 'builtin' },
        {
          id: editorId('material-instance'),
          selector: { kinds: ['material-instance'] },
          pageTypeId: MATERIAL_INSTANCE_PAGE,
          priority: 'default',
          sourceLayer: 'builtin',
        },
        {
          id: editorId('input-map'),
          selector: { kinds: ['input-map'] },
          pageTypeId: INPUT_MAP_PAGE,
          priority: 'default',
          sourceLayer: 'builtin',
        },
        {
          id: editorId('vfx'),
          selector: { kinds: ['particle-effect'] },
          pageTypeId: VFX_PAGE,
          priority: 'default',
          sourceLayer: 'builtin',
        },
        // The default editor. Enumerating kinds here was a latent bug: it listed
        // the retired `cube-texture` while never covering equirect /
        // animation-graph / video / particle-effect, and nothing caught it
        // because the shell's own kind switch fell back on its own. `asset.kind`
        // is an open string, so any kind without a dedicated page belongs here.
        {
          id: editorId('asset'),
          selector: { fallback: true },
          pageTypeId: ASSET_PAGE,
          priority: 'default',
          sourceLayer: 'builtin',
        },
      ],
    },
    setup(ctx) {
      hostRef = ctx.host;
      const toolClientProjection = createToolClientProjection();
      // Host transport may feed POD events into this observer. It exposes no
      // Gateway executor, World, registry, cancel, retry, or Project writer.
      const hostExtensions = ctx.host as typeof ctx.host & {
        extend?: (capability: string, value: unknown) => void;
      };
      hostExtensions.extend?.(EDITOR_OPERATIONS_OBSERVER_CAPABILITY, {
        projection: toolClientProjection,
        ingest: (event: ToolClientRunEvent) => applyToolClientRunEvent(toolClientProjection, event),
      });
      const releaseOperationsObserver = installOperationsObserverSource(toolClientProjection);
      // useActiveEditorAsset is backed by useSyncExternalStore. Keep the
      // derived Input Map asset identity stable until the page snapshot or its
      // staging metadata actually changes.
      let cachedPageSnapshot: unknown;
      let cachedSourceAsset: SelectedAsset | null | undefined;
      let cachedStagingName: string | undefined;
      let cachedStagingPackPath: string | undefined;
      let cachedActiveAsset: SelectedAsset | null = null;
      const activeAsset = (): SelectedAsset | null => {
        const snapshot = ctx.host.pages.getSnapshot();
        const instance = snapshot.instances.find((candidate) => candidate.encodedKey === snapshot.activeKey);
        const value = instance?.resource?.metadata?.asset;
        const asset = value && typeof value === 'object' ? value as SelectedAsset : null;
        const staging = instance?.typeId === INPUT_MAP_PAGE && asset
          ? getInputMapStaging(asset.guid)
          : undefined;
        const stagingName = staging?.name;
        const stagingPackPath = staging?.packPath;
        if (
          cachedPageSnapshot === snapshot
          && cachedSourceAsset === asset
          && cachedStagingName === stagingName
          && cachedStagingPackPath === stagingPackPath
        ) {
          return cachedActiveAsset;
        }

        cachedPageSnapshot = snapshot;
        cachedSourceAsset = asset;
        cachedStagingName = stagingName;
        cachedStagingPackPath = stagingPackPath;
        cachedActiveAsset = asset && staging
          ? { ...asset, name: staging.name, packPath: staging.packPath }
          : asset;
        return cachedActiveAsset;
      };
      const resetNavigation = configureEditorPageNavigation({
        async openAsset(asset) {
          // architecture.md forbids a consumer-side asset kind switch: the
          // resolver owns association > source layer > priority, so a user
          // association or an installed extension's editor wins here for free.
          await ctx.host.resourceEditors.open({
            canonicalId: asset.guid,
            uri: `forgeax-asset://${asset.guid}`,
            displayPath: asset.name,
            kind: asset.kind,
            metadata: { asset },
          });
        },
        getActiveAsset: activeAsset,
        subscribe: (listener) => {
          const unsubscribePages = ctx.host.pages.subscribe(listener);
          const unsubscribeStaging = subscribeInputMapStaging(listener);
          return () => {
            unsubscribePages();
            unsubscribeStaging();
          };
        },
      });
      const resetDirtyProbe = registerPageDirtyProbe({
        isDirty: (page) => {
          if (page.typeId === MATERIAL_PAGE) {
            const guid = page.resource?.canonicalId;
            return typeof guid === 'string' && isMaterialStagingDirty(guid);
          }
          if (page.typeId === MATERIAL_INSTANCE_PAGE) {
            const guid = page.resource?.canonicalId;
            return typeof guid === 'string' && isMiStagingDirty(guid);
          }
          if (page.typeId === INPUT_MAP_PAGE) {
            const guid = page.resource?.canonicalId;
            return typeof guid === 'string' && isInputMapStagingDirty(guid);
          }
          return false;
        },
        subscribe: (listener) => {
          const unsubMat = subscribeMaterialStaging(listener);
          const unsubMi = subscribeMiStaging(listener);
          const unsubIm = subscribeInputMapStaging(listener);
          return () => {
            unsubMat();
            unsubMi();
            unsubIm();
          };
        },
      });
      const resetActiveSave = registerActivePageSaveHandler(() => {
        const snapshot = ctx.host.pages.getSnapshot();

        const materialRevision = (instance: { resource?: { metadata?: { asset?: unknown }; canonicalId?: string } }) => {
          const asset = instance.resource?.metadata?.asset;
          return resolveProjectMaterialRevision(
            asset && typeof asset === 'object' && 'revision' in asset
              ? (asset as { revision?: unknown }).revision
              : undefined,
          );
        };

        // Dirty material pages win over scene save even when Level is the focused tab.
        for (const instance of snapshot.instances) {
          if (instance.typeId !== MATERIAL_PAGE) continue;
          const guid = instance.resource?.canonicalId;
          if (typeof guid !== 'string' || !isMaterialStagingDirty(guid)) continue;
          return invokeMaterialPageSave(instance.encodedKey, guid, materialRevision(instance));
        }

        // Staging can outlive a missing page tab / controller map entry.
        if (trySaveDirtyMaterialStaging()) return true;

        if (!snapshot.activeKey) return false;
        const instance = snapshot.instances.find((candidate) => candidate.encodedKey === snapshot.activeKey);
        if (!instance) return false;
        if (instance.typeId === MATERIAL_PAGE) {
          const guid = instance.resource?.canonicalId;
          return invokeMaterialPageSave(
            snapshot.activeKey,
            typeof guid === 'string' ? guid : undefined,
            materialRevision(instance),
          );
        }
        if (instance.typeId === MATERIAL_INSTANCE_PAGE) {
          const controller = getMiPageController(snapshot.activeKey);
          if (!controller?.save) return false;
          void Promise.resolve(controller.save()).catch(() => {});
          return true;
        }
        if (instance.typeId === INPUT_MAP_PAGE) {
          const controller = getInputMapPageController(snapshot.activeKey);
          if (!controller?.save) return false;
          void Promise.resolve(controller.save()).catch(() => {});
          return true;
        }
        return false;
      });
      const unsubscribeAssetLifecycle = subscribeAssetsChanged((event) => {
        if (event.mutation?.kind !== 'deleted') return;
        const guid = event.mutation.guid.toLowerCase();
        const pages = ctx.host.pages.getSnapshot().instances.filter(
          (instance) => instance.typeId === INPUT_MAP_PAGE
            && instance.resource?.canonicalId.toLowerCase() === guid,
        );
        for (const instance of pages) {
          void ctx.host.pages.close(instance.key, {
            reason: 'user',
            decision: 'discard',
          }).catch((cause) => {
            console.error('[input-map] failed to close deleted asset page', cause);
          });
        }
      });
      void ctx.host.pages.open({ typeId: LEVEL_PAGE });
      return () => {
        unsubscribeAssetLifecycle();
        releaseOperationsObserver();
        resetActiveSave();
        resetDirtyProbe();
        resetNavigation();
      };
    },
  };
}
