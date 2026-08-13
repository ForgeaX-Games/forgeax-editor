import { createElement } from 'react';
import {
  encodePageKey,
  qualifyContributionId,
  resolveContributionRef,
} from '@forgeax/types';
import { listExtensions, type ExtensionInfo } from '../../lib/extension-api';
import { WorkbenchExtensionPanel } from '../../components/DockShell/WorkbenchExtensionPanel';
import { isWorkbenchHostExtension } from '../../components/DockShell/workbenchRuntime';
import { getLocale } from '../../i18n';
import type { AppExtension } from './types';
import type {
  ActivityRegistration,
  PageTypeRegistration,
  PanelTypeRegistration,
  ResourceEditorRegistration,
} from '../page-platform';

function title(value: string | { zh?: string; en?: string; ja?: string }): string {
  if (typeof value === 'string') return value;
  const locale = getLocale();
  return value[locale] ?? value.en ?? value.zh ?? value.ja ?? '';
}

export function catalogExtensionItems(payload: unknown): readonly ExtensionInfo[] {
  if (!payload || typeof payload !== 'object') return [];
  const items = (payload as { items?: unknown }).items;
  return Array.isArray(items) ? items as ExtensionInfo[] : [];
}

type WorkbenchPane = 'left' | 'center';

export function workbenchPane(initialProps?: Readonly<Record<string, unknown>>): WorkbenchPane | undefined {
  const pane = initialProps?.pane;
  return pane === 'left' || pane === 'center' ? pane : undefined;
}

/** Adapt scanner-normalized panel types into Page runtime registrations. */
export function catalogPanelTypeRegistrations(item: ExtensionInfo): PanelTypeRegistration[] {
  return (item.contributes?.panelTypes ?? []).map((panel) => ({
    id: qualifyContributionId(item.id, 'panel', panel.id) as PanelTypeRegistration['id'],
    runtime: {
      kind: 'inline',
      render: (context) => createElement(WorkbenchExtensionPanel, {
        extensionId: item.id,
        pane: workbenchPane(context.initialProps),
      }),
    },
    // DetachedSurface can replay only the legacy standalone iframe path.
    // Workbench host extensions render WorkbenchRuntimeFrame in-dock and have no
    // detached counterpart yet, so advertising this capability would open the
    // wrong renderer.
    ...(item.entry?.standalone && !isWorkbenchHostExtension(item.id)
      ? {
          windowing: {
            createTarget: (context) => {
              const pane = workbenchPane(context.initialProps);
              return {
                surface: {
                  kind: 'plugin' as const,
                  id: item.id,
                  ...(pane ? { pane } : {}),
                  instance: `${encodePageKey(context.pageKey)}::${context.placementId}`,
                },
                title: title(item.displayName),
                width: 960,
                height: 720,
                dockBehavior: 'keep-anchor' as const,
              };
            },
          },
        }
      : {}),
  }));
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

    const panelTypes = catalogPanelTypeRegistrations(item);
    const pages: PageTypeRegistration[] = contributes.pages.map((page) => {
      const placements = (page.panels ?? []).map((placement) => ({
        id: placement.id,
        panelTypeId: resolveContributionRef(item.id, 'panel', placement.panelType) as PanelTypeRegistration['id'],
        title: placement.title ? title(placement.title) : undefined,
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
        layout: page.layout,
      };
    });
    const activities: ActivityRegistration[] = (contributes.activities ?? []).map((activity) => ({
      id: qualifyContributionId(item.id, 'activity', activity.id) as ActivityRegistration['id'],
      title: title(activity.title),
      titleI18n: typeof activity.title === 'string' ? undefined : activity.title,
      description: item.description ? title(item.description) : undefined,
      descriptionI18n: item.description && typeof item.description !== 'string'
        ? item.description
        : undefined,
      icon: activity.icon,
      category: activity.category,
      order: activity.order,
      // Host-injected source layer — scanner-loaded extensions are all
      // installed-tier, so they sort AFTER builtin core nav regardless of the
      // `order` they declare (or omit). Never taken from the manifest.
      sourceLayer: 'installed',
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
