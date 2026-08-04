import { createElement } from 'react';
import {
  qualifyContributionId,
  resolveContributionRef,
} from '@forgeax/types';
import { listExtensions, type ExtensionInfo } from '../../lib/extension-api';
import { WbExtensionDockPanel } from '../../components/DockShell/WbExtensionDockPanel';
import type { AppExtension } from './types';
import type {
  ActivityRegistration,
  PageTypeRegistration,
  PanelTypeRegistration,
  ResourceEditorRegistration,
} from '../page-platform';

function title(value: string | { zh?: string; en?: string; ja?: string }): string {
  return typeof value === 'string' ? value : value.zh ?? value.en ?? value.ja ?? '';
}

export function catalogExtensionItems(payload: unknown): readonly ExtensionInfo[] {
  if (!payload || typeof payload !== 'object') return [];
  const items = (payload as { items?: unknown }).items;
  return Array.isArray(items) ? items as ExtensionInfo[] : [];
}

/** Dockview's serialized transport always requires a branch root, including
 * the common one-group Page shape produced from normalized catalog manifests. */
export function catalogPageLayout(
  pageId: string,
  pageTitle: string,
  placements: readonly { readonly id: string }[],
): PageTypeRegistration['layout'] {
  const views = placements.map((placement) => placement.id);
  const groupId = `page-${pageId}`;
  return {
    grid: {
      height: 800,
      width: 1200,
      orientation: 'HORIZONTAL',
      root: {
        type: 'branch',
        size: 800,
        data: [{
          type: 'leaf',
          size: 1200,
          data: { views, activeView: views[0], id: groupId },
        }],
      },
    },
    panels: Object.fromEntries(placements.map((placement) => [placement.id, {
      id: placement.id,
      contentComponent: placement.id,
      title: placements.length === 1 ? pageTitle : placement.id,
    }])),
    activeGroup: groupId,
  } as PageTypeRegistration['layout'];
}

/** Browser-side activation of scanner-normalized page contributions. Hosts may
 * override an extension with a richer in-process implementation by using the
 * same extension id; those ids are filtered before this adapter runs. */
export async function loadCatalogPageExtensions(
  overriddenIds: ReadonlySet<string>,
): Promise<readonly AppExtension[]> {
  let items: readonly ExtensionInfo[];
  try { items = catalogExtensionItems(await listExtensions()); } catch { return []; }
  return items.flatMap((item): AppExtension[] => {
    const contributes = item.contributes;
    if (!contributes?.pages?.length || overriddenIds.has(item.id)) return [];

    const panelTypes: PanelTypeRegistration[] = (contributes.panelTypes ?? []).map((panel) => ({
      id: qualifyContributionId(item.id, 'panel', panel.id) as PanelTypeRegistration['id'],
      runtime: {
        kind: 'inline',
        render: () => createElement(WbExtensionDockPanel, { extensionId: item.id }),
      },
    }));
    const pages: PageTypeRegistration[] = contributes.pages.map((page) => {
      const placements = (page.panels ?? []).map((placement) => ({
        id: placement.id,
        panelTypeId: resolveContributionRef(item.id, 'panel', placement.panelType) as PanelTypeRegistration['id'],
        optional: placement.optional,
        initialProps: placement.initialProps,
      }));
      return {
        id: qualifyContributionId(item.id, 'page', page.id) as PageTypeRegistration['id'],
        title: title(page.title),
        cardinality: page.cardinality,
        restorePolicy: page.restorePolicy,
        layoutVersion: page.layoutVersion,
        panels: placements,
        layout: catalogPageLayout(page.id, title(page.title), placements),
      };
    });
    const activities: ActivityRegistration[] = (contributes.activities ?? []).map((activity) => ({
      id: qualifyContributionId(item.id, 'activity', activity.id) as ActivityRegistration['id'],
      title: title(activity.title),
      icon: activity.icon,
      category: activity.category,
      order: activity.order,
      pageTypeId: activity.pageType
        ? resolveContributionRef(item.id, 'page', activity.pageType) as PageTypeRegistration['id']
        : undefined,
      commandId: activity.commandId,
    }));
    const resourceEditors: ResourceEditorRegistration[] = (contributes.resourceEditors ?? []).map((editor) => ({
      id: qualifyContributionId(item.id, 'resource-editor', editor.id) as ResourceEditorRegistration['id'],
      selector: editor.selector,
      pageTypeId: resolveContributionRef(item.id, 'page', editor.pageType) as PageTypeRegistration['id'],
      priority: editor.priority,
      sourceLayer: 'installed',
    }));
    return [{
      id: item.id,
      version: item.version,
      requires: ['pages'],
      contributes: { panelTypes, pages, activities, resourceEditors },
    }];
  });
}
