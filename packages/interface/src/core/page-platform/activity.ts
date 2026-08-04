import type { ContributionRegistry } from '../extension-foundation/contribution-registry';
import type { CommandsRegistry } from '../extension-foundation/commands';
import type { ActivityRegistry, PagePlatformContribution, PagePort } from './types';
import type { QualifiedActivityId } from '@forgeax/types';

export function createActivityRegistry(
  contributions: ContributionRegistry<PagePlatformContribution>,
  pages: PagePort,
  commands: CommandsRegistry,
): ActivityRegistry {
  let cache: { readonly version: number; readonly snapshot: ReturnType<ActivityRegistry['getSnapshot']> } | undefined;

  const derive = (): ReturnType<ActivityRegistry['getSnapshot']> => {
    const version = contributions.version();
    if (cache?.version === version) return cache.snapshot;

    const activities = contributions.entries()
      .flatMap(({ owner, item }) => (item.activities ?? []).map((activity) => ({ ...activity, owner })))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
    const snapshot = { generation: version, activities };
    cache = { version, snapshot };
    return snapshot;
  };

  return {
    getSnapshot: derive,
    subscribe(listener) {
      return contributions.onChange(listener);
    },
    async launch(id: QualifiedActivityId) {
      const activity = this.getSnapshot().activities.find((candidate) => candidate.id === id);
      if (!activity) throw new Error(`activity "${id}" is not registered`);
      if (activity.pageTypeId) {
        await pages.open({ typeId: activity.pageTypeId });
        return;
      }
      if (activity.commandId) {
        await commands.execute(activity.commandId);
        return;
      }
      throw new Error(`activity "${id}" has no launch target`);
    },
  };
}
