import { describe, expect, it } from 'bun:test';
import { qualifyContributionId } from '@forgeax/types';
import { createCommandsRegistry } from '../extension-foundation/commands';
import { createContributionRegistry } from '../extension-foundation/contribution-registry';
import { createActivityRegistry } from './activity';
import type { PagePlatformContribution, PagePort } from './types';

describe('ActivityRegistry', () => {
  it('keeps the snapshot reference stable until contributions change', () => {
    const owner = '@forgeax/activity-snapshot-test';
    const pageTypeId = qualifyContributionId(owner, 'page', 'main');
    const activityId = qualifyContributionId(owner, 'activity', 'launcher');
    const contributions = createContributionRegistry<PagePlatformContribution>();
    const registry = createActivityRegistry(contributions, {} as PagePort, createCommandsRegistry());

    const empty = registry.getSnapshot();
    expect(registry.getSnapshot()).toBe(empty);

    contributions.contribute(owner, {
      activities: [{ id: activityId, title: 'Main', pageTypeId }],
    });
    const populated = registry.getSnapshot();
    expect(populated).not.toBe(empty);
    expect(registry.getSnapshot()).toBe(populated);
  });

  it('derives ordered launchers and routes them through PagePort', async () => {
    const owner = '@forgeax/activity-test';
    const pageTypeId = qualifyContributionId(owner, 'page', 'main');
    const activityId = qualifyContributionId(owner, 'activity', 'launcher');
    const contributions = createContributionRegistry<PagePlatformContribution>();
    const opened: string[] = [];
    const pages = {
      open: async ({ typeId }: { typeId: string }) => { opened.push(typeId); return { cardinality: 'singleton', typeId }; },
    } as PagePort;
    const registry = createActivityRegistry(contributions, pages, createCommandsRegistry());
    contributions.contribute(owner, { activities: [{ id: activityId, title: 'Main', order: 2, pageTypeId }] });

    expect(registry.getSnapshot().activities.map((item) => item.id)).toEqual([activityId]);
    await registry.launch(activityId);
    expect(opened).toEqual([pageTypeId]);
  });

  it('sorts by sourceLayer first, then order (unranked plugins fall to layer middle, never the front)', () => {
    const owner = '@forgeax/activity-order-test';
    const mk = (local: string) => qualifyContributionId(owner, 'activity', local);
    const builtinLate = mk('builtin-late');     // builtin, order 20
    const builtinEarly = mk('builtin-early');   // builtin, order 10
    const installedRanked = mk('installed-5');  // installed, order 5 (small, but installed)
    const installedUnranked = mk('installed-x'); // installed, NO order → ORDER_BASE
    const contributions = createContributionRegistry<PagePlatformContribution>();
    const registry = createActivityRegistry(contributions, {} as PagePort, createCommandsRegistry());

    contributions.contribute(owner, {
      activities: [
        { id: installedUnranked, title: 'Plugin', sourceLayer: 'installed' },
        { id: builtinLate, title: 'B2', sourceLayer: 'builtin', order: 20 },
        { id: installedRanked, title: 'Plugin', sourceLayer: 'installed', order: 5 },
        { id: builtinEarly, title: 'B1', sourceLayer: 'builtin', order: 10 },
      ],
    });

    // builtin layer wins outright over installed — an installed plugin with
    // order:5 still ranks BELOW builtin order:20; unranked plugin sits last.
    expect(registry.getSnapshot().activities.map((item) => item.id)).toEqual([
      builtinEarly,
      builtinLate,
      installedRanked,
      installedUnranked,
    ]);
  });
});
