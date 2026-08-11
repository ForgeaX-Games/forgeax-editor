import type { ContributionRegistry } from '../extension-foundation/contribution-registry';
import type { CommandsRegistry } from '../extension-foundation/commands';
import type { ActivityRegistry, PagePlatformContribution, PagePort } from './types';
import type { QualifiedActivityId } from '@forgeax/types';

// Rail sort layers (§ActivityRegistration.sourceLayer). Lower rank ⇒ earlier;
// builtin core nav always precedes plugins, which caps any plugin `order`.
const LAYER_RANK: Record<string, number> = { builtin: 0, project: 1, installed: 2, user: 3 };
// `order` default anchor.升序里 0 = 最靠前，等于把「未表态」翻译成「抢第一」——
// 用居中锚点代替，未声明 order 的活动落层内中部，前后都留插空。
const ORDER_BASE = 1000;
// Absent / unknown layer ⇒ treated as installed (rank 2), so it sits with
// plugins below builtin. Literal fallback keeps the return a plain `number`
// under noUncheckedIndexedAccess.
const layerRank = (layer?: string): number => LAYER_RANK[layer ?? 'installed'] ?? 2;

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
      .sort((a, b) =>
        layerRank(a.sourceLayer) - layerRank(b.sourceLayer)
        || (a.order ?? ORDER_BASE) - (b.order ?? ORDER_BASE)
        || a.id.localeCompare(b.id),
      );
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
