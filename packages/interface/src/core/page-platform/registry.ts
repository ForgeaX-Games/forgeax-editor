import type { ContributionRegistry } from '../extension-foundation/contribution-registry';
import type {
  PageLayoutEnvelope,
  PageLayoutNode,
  QualifiedPageTypeId,
  QualifiedPanelTypeId,
} from '@forgeax/types';
import type {
  PagePlatformContribution,
  PageRegistry,
  PageRegistrySnapshot,
  PageTypeRegistration,
  PanelTypeRegistration,
  ResolvedPageType,
} from './types';
import { PagePlatformError } from './types';

function ownerFromQualifiedId(id: string): string | undefined {
  const separator = id.indexOf('#');
  return separator > 0 ? id.slice(0, separator) : undefined;
}

function sanitizeLayoutNode(node: PageLayoutNode, allowed: ReadonlySet<string>): PageLayoutNode | undefined {
  if (node.kind === 'tabs') {
    const placements = node.placements.filter((placement) => allowed.has(placement));
    if (placements.length === 0) return undefined;
    return {
      kind: 'tabs',
      placements,
      ...(node.active && placements.includes(node.active) ? { active: node.active } : {}),
    };
  }

  const children = node.children
    .map((child) => sanitizeLayoutNode(child, allowed))
    .filter((child): child is PageLayoutNode => child !== undefined);
  if (children.length === 0) return undefined;
  if (children.length === 1) return children[0];
  return {
    kind: 'split',
    direction: node.direction,
    children,
    ...(node.sizes?.length === children.length ? { sizes: node.sizes } : {}),
  };
}

function sanitizedLayout(layout: PageLayoutEnvelope, allowed: ReadonlySet<string>): PageLayoutEnvelope {
  return {
    version: layout.version,
    root: sanitizeLayoutNode(layout.root, allowed) ?? { kind: 'tabs', placements: [] },
  };
}

function isPageLayoutEnvelope(layout: PageTypeRegistration['layout']): layout is PageLayoutEnvelope {
  return 'version' in layout && 'root' in layout;
}

export function createPageRegistry(
  contributions: ContributionRegistry<PagePlatformContribution>,
): PageRegistry {
  let cache: { readonly version: number; readonly snapshot: PageRegistrySnapshot } | undefined;

  const derive = (): PageRegistrySnapshot => {
    const version = contributions.version();
    if (cache?.version === version) return cache.snapshot;

    const panels = new Map<QualifiedPanelTypeId, PanelTypeRegistration>();
    const duplicatePanels = new Set<QualifiedPanelTypeId>();
    const pages = new Map<QualifiedPageTypeId, Array<{ owner: string; definition: PageTypeRegistration }>>();

    for (const entry of contributions.entries()) {
      for (const panel of entry.item.panelTypes ?? []) {
        if (panels.has(panel.id)) duplicatePanels.add(panel.id);
        else panels.set(panel.id, panel);
      }
      for (const page of entry.item.pageTypes ?? []) {
        const registrations = pages.get(page.id) ?? [];
        registrations.push({ owner: entry.owner, definition: page });
        pages.set(page.id, registrations);
      }
    }
    for (const id of duplicatePanels) panels.delete(id);

    const resolvedPages = new Map<QualifiedPageTypeId, ResolvedPageType>();
    for (const [id, registrations] of pages) {
      const first = registrations[0]!;
      if (registrations.length > 1) {
        resolvedPages.set(id, {
          status: 'unavailable',
          owner: first.owner,
          definition: first.definition,
          reason: 'duplicate-page-type',
          missingPanelTypeIds: [],
        });
        continue;
      }

      const missingRequired: QualifiedPanelTypeId[] = [];
      const resolvedPanels = first.definition.panels.flatMap((placement) => {
        const panelType = panels.get(placement.panelTypeId);
        if (!panelType) {
          if (!placement.optional) missingRequired.push(placement.panelTypeId);
          return [];
        }
        return [{ ...placement, panelType }];
      });

      if (missingRequired.length > 0) {
        resolvedPages.set(id, {
          status: 'unavailable',
          owner: first.owner,
          definition: first.definition,
          reason: 'missing-required-panel',
          missingPanelTypeIds: missingRequired,
        });
        continue;
      }

      const allowed = new Set(resolvedPanels.map((placement) => placement.id));
      resolvedPages.set(id, {
        status: 'available',
        owner: first.owner,
        definition: first.definition,
        panels: resolvedPanels,
        layout: isPageLayoutEnvelope(first.definition.layout)
          ? sanitizedLayout(first.definition.layout, allowed)
          : first.definition.layout,
      });
    }

    const snapshot: PageRegistrySnapshot = {
      generation: version,
      pageTypes: resolvedPages,
      panelTypes: panels,
    };
    cache = { version, snapshot };
    return snapshot;
  };

  return {
    get(typeId) {
      return derive().pageTypes.get(typeId);
    },
    ownerOf(typeId) {
      return derive().pageTypes.get(typeId)?.owner;
    },
    getSnapshot: derive,
    subscribe(listener) {
      return contributions.onChange(listener);
    },
    validateContribution(owner, contribution) {
      const existing = derive();
      const pageIds = new Set<QualifiedPageTypeId>();
      const panelIds = new Set<QualifiedPanelTypeId>();

      for (const panel of contribution.panelTypes ?? []) panelIds.add(panel.id);

      for (const page of contribution.pageTypes ?? []) {
        if (ownerFromQualifiedId(page.id) !== owner) {
          throw new PagePlatformError(
            'PAGE_CONTRIBUTION_OWNER_MISMATCH',
            `page type "${page.id}" does not belong to "${owner}"`,
            { owner, id: page.id },
          );
        }
        if (pageIds.has(page.id) || existing.pageTypes.has(page.id)) {
          throw new PagePlatformError(
            'PAGE_CONTRIBUTION_CONFLICT',
            `page type "${page.id}" is already registered`,
            { owner, id: page.id },
          );
        }
        pageIds.add(page.id);
        const placementIds = new Set<string>();
        for (const placement of page.panels) {
          if (placementIds.has(placement.id)) {
            throw new PagePlatformError(
              'PAGE_CONTRIBUTION_CONFLICT',
              `page type "${page.id}" declares placement "${placement.id}" more than once`,
              { owner, id: page.id, placementId: placement.id },
            );
          }
          placementIds.add(placement.id);
          if (
            !placement.optional &&
            !panelIds.has(placement.panelTypeId) &&
            !existing.panelTypes.has(placement.panelTypeId)
          ) {
            throw new PagePlatformError(
              'PAGE_TYPE_UNAVAILABLE',
              `page type "${page.id}" requires missing panel type "${placement.panelTypeId}"`,
              { owner, id: page.id, panelTypeId: placement.panelTypeId },
            );
          }
        }
      }

      for (const panel of contribution.panelTypes ?? []) {
        if (ownerFromQualifiedId(panel.id) !== owner) {
          throw new PagePlatformError(
            'PAGE_CONTRIBUTION_OWNER_MISMATCH',
            `panel type "${panel.id}" does not belong to "${owner}"`,
            { owner, id: panel.id },
          );
        }
        if (
          (contribution.panelTypes ?? []).filter((candidate) => candidate.id === panel.id).length > 1 ||
          existing.panelTypes.has(panel.id)
        ) {
          throw new PagePlatformError(
            'PAGE_CONTRIBUTION_CONFLICT',
            `panel type "${panel.id}" is already registered`,
            { owner, id: panel.id },
          );
        }
      }

      const knownPage = (id: QualifiedPageTypeId): boolean => pageIds.has(id) || existing.pageTypes.has(id);
      const contributionIds = new Set<string>();
      for (const activity of contribution.activities ?? []) {
        if (ownerFromQualifiedId(activity.id) !== owner) {
          throw new PagePlatformError('PAGE_CONTRIBUTION_OWNER_MISMATCH', `activity "${activity.id}" does not belong to "${owner}"`);
        }
        if (contributionIds.has(activity.id)) {
          throw new PagePlatformError('PAGE_CONTRIBUTION_CONFLICT', `activity "${activity.id}" is already registered`);
        }
        contributionIds.add(activity.id);
        if (Number(Boolean(activity.pageTypeId)) + Number(Boolean(activity.commandId)) !== 1) {
          throw new PagePlatformError('PAGE_TYPE_UNAVAILABLE', `activity "${activity.id}" must have exactly one launch target`);
        }
        if (activity.pageTypeId && !knownPage(activity.pageTypeId)) {
          throw new PagePlatformError('PAGE_TYPE_UNAVAILABLE', `activity "${activity.id}" references missing page type "${activity.pageTypeId}"`);
        }
      }
      for (const editor of contribution.resourceEditors ?? []) {
        if (ownerFromQualifiedId(editor.id) !== owner) {
          throw new PagePlatformError('PAGE_CONTRIBUTION_OWNER_MISMATCH', `resource editor "${editor.id}" does not belong to "${owner}"`);
        }
        if (contributionIds.has(editor.id)) {
          throw new PagePlatformError('PAGE_CONTRIBUTION_CONFLICT', `resource editor "${editor.id}" is already registered`);
        }
        contributionIds.add(editor.id);
        if (!knownPage(editor.pageTypeId)) {
          throw new PagePlatformError('PAGE_TYPE_UNAVAILABLE', `resource editor "${editor.id}" references missing page type "${editor.pageTypeId}"`);
        }
      }
    },
  };
}
