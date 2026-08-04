import { describe, expect, it } from 'bun:test';
import { qualifyContributionId } from '@forgeax/types';
import { createContributionRegistry } from '../extension-foundation/contribution-registry';
import { createPageRegistry } from './registry';
import type { PagePlatformContribution } from './types';

const owner = '@forgeax-plugin/page-test';
const pageId = qualifyContributionId(owner, 'page', 'workspace');
const mainPanelId = qualifyContributionId(owner, 'panel', 'main');
const optionalPanelId = qualifyContributionId(owner, 'panel', 'optional');

const page = {
  id: pageId,
  title: 'Workspace',
  cardinality: 'singleton' as const,
  layout: {
    version: 1,
    root: { kind: 'tabs' as const, placements: ['main', 'optional'], active: 'optional' },
  },
  panels: [
    { id: 'main', panelTypeId: mainPanelId },
    { id: 'optional', panelTypeId: optionalPanelId, optional: true },
  ],
};

describe('PageRegistry', () => {
  it('resolves required panels and prunes missing optional placements from layout', () => {
    const contributions = createContributionRegistry<PagePlatformContribution>();
    const registry = createPageRegistry(contributions);
    contributions.contribute(owner, {
      panelTypes: [{ id: mainPanelId, runtime: { kind: 'inline', render: () => null } }],
      pageTypes: [page],
    });

    const resolved = registry.get(pageId);
    expect(resolved?.status).toBe('available');
    if (resolved?.status !== 'available') return;
    expect(resolved.panels.map((placement) => placement.id)).toEqual(['main']);
    expect(resolved.layout.root).toEqual({ kind: 'tabs', placements: ['main'] });
  });

  it('marks a page unavailable when a required panel type is missing', () => {
    const contributions = createContributionRegistry<PagePlatformContribution>();
    const registry = createPageRegistry(contributions);
    contributions.contribute(owner, { pageTypes: [page] });

    const resolved = registry.get(pageId);
    expect(resolved?.status).toBe('unavailable');
    if (resolved?.status !== 'unavailable') return;
    expect(resolved.reason).toBe('missing-required-panel');
    expect(resolved.missingPanelTypeIds).toEqual([mainPanelId]);
  });

  it('rejects conflicts and owner/id mismatches before publication', () => {
    const contributions = createContributionRegistry<PagePlatformContribution>();
    const registry = createPageRegistry(contributions);
    const contribution = {
      panelTypes: [{ id: mainPanelId, runtime: { kind: 'inline' as const, render: () => null } }],
      pageTypes: [page],
    };
    registry.validateContribution(owner, contribution);
    contributions.contribute(owner, contribution);

    expect(() => registry.validateContribution(owner, contribution)).toThrow('already registered');
    expect(() => registry.validateContribution('@forgeax-plugin/other', { pageTypes: [page] })).toThrow(
      'does not belong',
    );
  });

  it('fails staging when a required panel reference is unresolved', () => {
    const contributions = createContributionRegistry<PagePlatformContribution>();
    const registry = createPageRegistry(contributions);
    expect(() => registry.validateContribution(owner, { pageTypes: [page] })).toThrow(
      'requires missing panel type',
    );
    expect(contributions.version()).toBe(0);
  });
});
