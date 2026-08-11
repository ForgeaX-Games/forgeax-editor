import type { ActivityRegistration } from '../../core/page-platform';

export type ActivityRailCategory = '3D' | '2D' | 'general';
export type ActivityRailEntry = ActivityRegistration & { readonly owner: string };

const CATEGORY_ORDER: readonly ActivityRailCategory[] = ['3D', '2D', 'general'];
export const DEFAULT_PINNED_ACTIVITY_SLUGS = [
  'wb-skill',
  'wb-gen3d',
  'wb-3d-lowpoly',
  'wb-character',
  'wb-items',
  'wb-anim',
  'wb-2d-scene-asset-generator',
  'wb-ui',
  'wb-narrative',
  'wb-reel',
  'wb-bgm',
  'wb-scene-generator',
] as const;

function contributionLocalId(id: string): string | undefined {
  return id.match(/#activity\/(.+)$/)?.[1];
}

function ownerSlug(owner: string): string {
  return owner.split('/').filter(Boolean).at(-1)?.toLowerCase() ?? owner.toLowerCase();
}

function localizedText(
  value: ActivityRegistration['titleI18n'],
  locale: string,
  fallback: string,
): string {
  if (!value) return fallback;
  const language = locale.toLowerCase().split('-')[0];
  if (language === 'zh') return value.zh ?? value.en ?? value.ja ?? fallback;
  if (language === 'ja') return value.ja ?? value.en ?? value.zh ?? fallback;
  return value.en ?? value.zh ?? value.ja ?? fallback;
}

export function localizeActivityRailEntries(
  activities: readonly ActivityRailEntry[],
  locale: string,
): readonly ActivityRailEntry[] {
  return activities.map((activity) => ({
    ...activity,
    title: localizedText(activity.titleI18n, locale, activity.title),
    description: localizedText(
      activity.descriptionI18n,
      locale,
      activity.description ?? '',
    ) || undefined,
  }));
}

function legacyAliases(activity: ActivityRailEntry): string[] {
  const owner = ownerSlug(activity.owner);
  const localId = contributionLocalId(activity.id);
  return [
    activity.id,
    activity.owner,
    owner,
    owner.replace(/^wb-/, ''),
    localId,
    localId?.replace(/^wb[:-]?/, ''),
  ].filter((value): value is string => Boolean(value));
}

export function activityRailCategory(activity: ActivityRailEntry): ActivityRailCategory {
  const declared = activity.category?.trim().toLowerCase();
  if (declared === '3d') return '3D';
  if (declared === '2d') return '2D';
  if (declared === 'general') return 'general';
  return 'general';
}

export function discoverableActivities(
  activities: readonly ActivityRailEntry[],
): readonly ActivityRailEntry[] {
  return activities.filter((activity) => activity.sourceLayer !== 'builtin');
}

export interface ActivityRailGroup {
  readonly category: ActivityRailCategory;
  readonly items: readonly ActivityRailEntry[];
}

export function groupDiscoverableActivities(
  activities: readonly ActivityRailEntry[],
  query: string,
): readonly ActivityRailGroup[] {
  const normalizedQuery = query.trim().toLowerCase();
  const groups = new Map<ActivityRailCategory, ActivityRailEntry[]>(
    CATEGORY_ORDER.map((category) => [category, []]),
  );

  for (const activity of discoverableActivities(activities)) {
    if (normalizedQuery && ![
      activity.title,
      activity.description ?? '',
      activity.id,
      activity.owner,
    ].some((value) => value.toLowerCase().includes(normalizedQuery))) {
      continue;
    }
    groups.get(activityRailCategory(activity))?.push(activity);
  }

  return CATEGORY_ORDER
    .map((category) => ({ category, items: groups.get(category) ?? [] }))
    .filter((group) => group.items.length > 0);
}

export function pinnedActivities(
  activities: readonly ActivityRailEntry[],
  pinnedIds: readonly string[],
): readonly ActivityRailEntry[] {
  const pinned = new Set(pinnedIds);
  const selected = activities.filter((activity) =>
    activity.sourceLayer === 'builtin' || pinned.has(activity.id),
  );
  const defaultRank = (activity: ActivityRailEntry): number => {
    const aliases = new Set(legacyAliases(activity).map((alias) => alias.toLowerCase()));
    const rank = DEFAULT_PINNED_ACTIVITY_SLUGS.findIndex((slug) => aliases.has(slug));
    return rank < 0 ? Number.POSITIVE_INFINITY : rank;
  };
  return selected
    .map((activity, registryIndex) => ({ activity, registryIndex }))
    .sort((left, right) => {
      if (left.activity.sourceLayer === 'builtin' || right.activity.sourceLayer === 'builtin') {
        return left.registryIndex - right.registryIndex;
      }
      return defaultRank(left.activity) - defaultRank(right.activity)
        || left.registryIndex - right.registryIndex;
    })
    .map(({ activity }) => activity);
}

export function migrateLegacyPinnedActivityIds(
  legacyIds: readonly string[],
  activities: readonly ActivityRailEntry[],
): string[] {
  const aliasToQualifiedId = new Map<string, string>();
  for (const activity of activities) {
    for (const alias of legacyAliases(activity)) {
      const normalized = alias.toLowerCase();
      if (!aliasToQualifiedId.has(normalized)) aliasToQualifiedId.set(normalized, activity.id);
    }
  }

  const migrated: string[] = [];
  const seen = new Set<string>();
  for (const legacyId of legacyIds) {
    const qualifiedId = legacyId.includes('#activity/')
      ? legacyId
      : aliasToQualifiedId.get(legacyId.toLowerCase());
    if (qualifiedId && !seen.has(qualifiedId)) {
      seen.add(qualifiedId);
      migrated.push(qualifiedId);
    }
  }
  return migrated;
}

export function defaultPinnedActivityIds(
  activities: readonly ActivityRailEntry[],
): string[] {
  return migrateLegacyPinnedActivityIds(DEFAULT_PINNED_ACTIVITY_SLUGS, activities);
}
