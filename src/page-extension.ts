import type { ReactNode } from 'react';
import type { AppExtension } from '@forgeax/interface/core/app-shell/types';
import type {
  ActivityRegistration,
  PagePanelPlacement,
  PageTypeRegistration,
  PanelTypeRegistration,
  ResourceEditorRegistration,
} from '@forgeax/interface/core/page-platform';
import {
  configureEditorPageNavigation,
  type SelectedAsset,
} from '@forgeax/editor-core';
import {
  DEFAULT_ASSET_EDITOR_DOCK_LAYOUT,
  DEFAULT_EDITOR_DOCK_LAYOUT,
  DEFAULT_MESH_EDITOR_DOCK_LAYOUT,
} from './default-dock-layout';

const OWNER = '@forgeax/editor';
const pageId = (id: string) => `${OWNER}#page/${id}` as PageTypeRegistration['id'];
const panelId = (id: string) => `${OWNER}#panel/${id}` as PanelTypeRegistration['id'];
const activityId = (id: string) => `${OWNER}#activity/${id}` as ActivityRegistration['id'];
const editorId = (id: string) => `${OWNER}#resource-editor/${id}` as ResourceEditorRegistration['id'];

const LEVEL_PAGE = pageId('level');
const ASSET_PAGE = pageId('asset');
const MESH_PAGE = pageId('mesh');
const MATERIAL_PAGE = pageId('material');

const LEVEL_PANELS = ['ep:hierarchy', 'ep:inspector', 'viewport', 'info', 'ep:assets', 'ep:history'];
const ASSET_PANELS = ['ep:asset-properties', 'ep:asset-overview'];
const MESH_PANELS = [...ASSET_PANELS, 'ep:mesh-slots'];

function placements(ids: readonly string[]): PagePanelPlacement[] {
  return ids.map((id) => ({ id, panelTypeId: panelId(id.replace(/^ep:/u, '')) }));
}

function page(
  id: PageTypeRegistration['id'],
  title: string,
  cardinality: PageTypeRegistration['cardinality'],
  layout: PageTypeRegistration['layout'],
  ids: readonly string[],
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
  };
}

function pageForAsset(asset: SelectedAsset): PageTypeRegistration['id'] {
  if (asset.kind === 'mesh') return MESH_PAGE;
  if (asset.kind === 'material') return MATERIAL_PAGE;
  return ASSET_PAGE;
}

export function createEditorPageExtension(
  renderPanel: (id: string) => ReactNode,
): AppExtension {
  const allPanelIds = [...new Set([...LEVEL_PANELS, ...MESH_PANELS])];
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
        page(LEVEL_PAGE, 'Level', 'singleton', DEFAULT_EDITOR_DOCK_LAYOUT, LEVEL_PANELS),
        page(ASSET_PAGE, 'Asset', 'resource', DEFAULT_ASSET_EDITOR_DOCK_LAYOUT, ASSET_PANELS),
        page(MESH_PAGE, 'Mesh', 'resource', DEFAULT_MESH_EDITOR_DOCK_LAYOUT, MESH_PANELS),
        page(MATERIAL_PAGE, 'Material', 'resource', DEFAULT_ASSET_EDITOR_DOCK_LAYOUT, ASSET_PANELS),
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
      void ctx.host.pages.open({ typeId: LEVEL_PAGE });
      return resetNavigation;
    },
  };
}
