import { describe, expect, it } from 'bun:test';
import { qualifyContributionId } from '@forgeax/types';
import { createContributionRegistry } from '../../core/extension-foundation/contribution-registry';
import { createPageRegistry } from '../../core/page-platform/registry';
import type { PagePlatformContribution, PageTypeRegistration } from '../../core/page-platform';
import { openablePageTypes } from './openablePageTypes';

const owner = '@forgeax-plugin/page-menu-test';
const panelId = qualifyContributionId(owner, 'panel', 'main');

function page(
  localId: string,
  title: string,
  cardinality: PageTypeRegistration['cardinality'],
  targetPanelId = panelId,
): PageTypeRegistration {
  return {
    id: qualifyContributionId(owner, 'page', localId),
    title,
    cardinality,
    layout: { version: 1, root: { kind: 'tabs', placements: ['main'] } },
    panels: [{ id: 'main', panelTypeId: targetPanelId }],
  };
}

describe('openablePageTypes', () => {
  it('keeps available resource-free types and sorts them by title', () => {
    const contributions = createContributionRegistry<PagePlatformContribution>();
    const registry = createPageRegistry(contributions);
    contributions.contribute(owner, {
      panelTypes: [{ id: panelId, runtime: { kind: 'inline', render: () => null } }],
      pageTypes: [
        page('zebra', 'Zebra', 'singleton'),
        page('alpha', 'Alpha', 'multi-instance'),
        page('resource', 'Resource', 'resource'),
        page(
          'unavailable',
          'Unavailable',
          'singleton',
          qualifyContributionId(owner, 'panel', 'missing'),
        ),
      ],
    });

    expect(openablePageTypes(registry.getSnapshot())).toEqual([
      {
        id: qualifyContributionId(owner, 'page', 'alpha'),
        title: 'Alpha',
        cardinality: 'multi-instance',
      },
      {
        id: qualifyContributionId(owner, 'page', 'zebra'),
        title: 'Zebra',
        cardinality: 'singleton',
      },
    ]);
  });
});
