import {
  childrenOf,
  entComponents,
  entName,
  gateway,
  listComponentSchemas,
  worldEntityHandles,
  type EntityHandle,
} from '@forgeax/editor-core';

export const HIERARCHY_SCENE_FOLDER_ID = -1 as EntityHandle;

export interface HierarchyColumns {
  readonly type: boolean;
  readonly mobility: boolean;
  readonly id: boolean;
}

export interface HierarchySnapshot {
  readonly searchQuery: string;
  readonly filters: ReadonlySet<string>;
  readonly columns: HierarchyColumns;
  readonly collapsed: ReadonlySet<EntityHandle>;
}

export interface HierarchyFilterOption {
  readonly id: string;
  readonly label: string;
  readonly count: number;
}

// The hierarchy "type" is DERIVED from an entity's live components (engine
// reflection via entComponents), never a hand-maintained enum. The only
// editor-side sugar is these tables:
//
//  - LOW_TIER_COMPONENTS: infrastructure (almost) every entity carries, so it
//    never characterizes the entity. It is the LOWEST representative priority:
//    a node shown as one of these means it has nothing else → treat as a bare
//    'entity'. `Children` is deliberately NOT here — it is the mid-tier "has
//    children" signal (see getHierarchyEntityType), ranked above infra but below
//    any real intent component.
//  - CATEGORY_RULES: a COSMETIC substring→category hint used ONLY for the icon
//    and the intra-tier sort priority. It NEVER gates correctness: a component
//    matching nothing lands in 'generic' and shows its own raw name with a
//    generic icon. Engine components can be added or removed with zero change
//    here, and an unknown component can never throw.
// `Entity` is the id=0 marker component the engine puts on EVERY entity, so it
// must sit at the floor too — otherwise it beats a real component alphabetically
// (e.g. Entity < Skylight) and every node reads "entity".
const LOW_TIER_COMPONENTS: ReadonlySet<string> = new Set(['Entity', 'Transform', 'EditorHidden', 'ChildOf', 'Name']);

// The relationship component the engine mirrors onto a parent entity. Its
// presence is the "this node is a group" signal; ranked above infra but below
// any real intent component (a Light with children still reads as a Light).
const CHILDREN_COMPONENT = 'Children';

export type HierarchyTypeCategory =
  | 'camera' | 'light' | 'character' | 'start' | 'spawner' | 'mesh'
  | 'group' | 'entity' | 'generic';

export const HIERARCHY_GROUP_TYPE_ID = 'group';
export const HIERARCHY_ENTITY_TYPE_ID = 'entity';

// Table order IS the representative-pick priority: a Light+RigidBody entity
// shows "light" because light precedes the (generic) rigidbody. The structural
// fallbacks (group/entity) are decided outside this table.
const CATEGORY_RULES: readonly { readonly test: RegExp; readonly category: HierarchyTypeCategory }[] = [
  { test: /Camera/, category: 'camera' },
  { test: /Light/, category: 'light' },
  { test: /Character|Controller/, category: 'character' },
  { test: /PlayerStart/, category: 'start' },
  { test: /Spawner/, category: 'spawner' },
  { test: /Mesh/, category: 'mesh' },
];

/** Map a hierarchy type id (a component name, or the 'group'/'entity' structural
 *  ids) to a COSMETIC display category. Unknown component → 'generic'. */
export function hierarchyTypeCategory(id: string): HierarchyTypeCategory {
  if (id === HIERARCHY_GROUP_TYPE_ID) return 'group';
  if (id === HIERARCHY_ENTITY_TYPE_ID) return 'entity';
  for (const rule of CATEGORY_RULES) if (rule.test.test(id)) return rule.category;
  return 'generic';
}

/** The localized display label for a component name (or the 'group'/'entity'
 *  structural ids). Each id is looked up per-name as `editor.hierarchy.types.<id>`;
 *  a component with NO such key falls back to its raw English name. So every
 *  distinct component keeps a distinct label (the four light components read as
 *  four names, not one merged "Light"; MeshFilter vs MeshRenderer stay separate),
 *  and a never-seen-before component still renders. Shared by the hierarchy type
 *  column, the hierarchy filter menu, and the Inspector component list (SSOT).
 *  Relies on `t` returning the key itself on a miss (see core i18n `t`). */
export function componentTypeLabel(id: string, t: (key: string) => string): string {
  const key = `editor.hierarchy.types.${id}`;
  const translated = t(key);
  return translated === key ? id : translated;
}

function categoryRank(category: HierarchyTypeCategory): number {
  const index = CATEGORY_RULES.findIndex((rule) => rule.category === category);
  return index === -1 ? CATEGORY_RULES.length : index;
}

// Total order over component names: characterizing category first (CATEGORY_RULES
// order), then alphabetical. Drives both the representative pick and the filter
// list ordering, so the two never disagree.
function compareComponentNames(a: string, b: string): number {
  const ra = categoryRank(hierarchyTypeCategory(a));
  const rb = categoryRank(hierarchyTypeCategory(b));
  return ra - rb || a.localeCompare(b);
}

const DEFAULT_COLUMNS: HierarchyColumns = {
  type: true,
  mobility: true,
  id: false,
};

const COLLAPSE_KEY = 'forgeax:editor:hier-collapsed';
function loadCollapsed(): Set<EntityHandle> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if (raw) return new Set(JSON.parse(raw) as EntityHandle[]);
  } catch {
    /* ignore corrupt persisted state */
  }
  return new Set();
}

function saveCollapsed(set: ReadonlySet<EntityHandle>): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]));
  } catch {
    /* storage may be unavailable */
  }
}

let snapshot: HierarchySnapshot = {
  searchQuery: '',
  filters: new Set(),
  columns: DEFAULT_COLUMNS,
  collapsed: loadCollapsed(),
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function nextSnapshot(next: HierarchySnapshot): void {
  snapshot = next;
  emit();
}

export function subscribeHierarchyPanelState(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getHierarchyPanelSnapshot(): HierarchySnapshot {
  return snapshot;
}

export function setHierarchySearchQuery(value: string): void {
  nextSnapshot({ ...snapshot, searchQuery: value });
}

export function clearHierarchySearchQuery(): void {
  if (!snapshot.searchQuery) return;
  setHierarchySearchQuery('');
}

export function toggleHierarchyFilter(id: string): void {
  const filters = new Set(snapshot.filters);
  if (filters.has(id)) filters.delete(id);
  else filters.add(id);
  nextSnapshot({ ...snapshot, filters });
}

export function clearHierarchyFilters(): void {
  if (snapshot.filters.size === 0) return;
  nextSnapshot({ ...snapshot, filters: new Set() });
}

export function toggleHierarchyColumn(column: keyof HierarchyColumns): void {
  nextSnapshot({
    ...snapshot,
    columns: {
      ...snapshot.columns,
      [column]: !snapshot.columns[column],
    },
  });
}

export function resetHierarchyViewState(): void {
  nextSnapshot({
    searchQuery: '',
    filters: new Set(),
    columns: DEFAULT_COLUMNS,
    collapsed: snapshot.collapsed,
  });
}

export function toggleHierarchyCollapsed(id: EntityHandle): void {
  const collapsed = new Set(snapshot.collapsed);
  if (collapsed.has(id)) collapsed.delete(id);
  else collapsed.add(id);
  saveCollapsed(collapsed);
  nextSnapshot({ ...snapshot, collapsed });
}

export function expandHierarchyAll(): void {
  const collapsed = new Set<EntityHandle>();
  saveCollapsed(collapsed);
  nextSnapshot({ ...snapshot, collapsed });
}

export function collapseHierarchyAll(): void {
  const collapsed = new Set([HIERARCHY_SCENE_FOLDER_ID, ...getHierarchyParentEntities()]);
  saveCollapsed(collapsed);
  nextSnapshot({ ...snapshot, collapsed });
}

export function toggleHierarchyCollapseAll(): void {
  const parents = getHierarchyParentEntities();
  const allCollapsed = parents.length > 0 && parents.every((id) => snapshot.collapsed.has(id));
  if (allCollapsed) expandHierarchyAll();
  else collapseHierarchyAll();
}

/** The filter menu's options: the REGISTERED component set from the engine's
 *  reflection registry (listComponentSchemas) — the same code-derived source the
 *  Inspector's Add-Component menu uses (ADDABLE_COMPONENTS). It is a property of
 *  the loaded code, NOT of the current world, so the menu is fully populated even
 *  in an empty scene and never drifts from what can actually exist. A newly
 *  registered component auto-appears with no change here. `count` is a best-effort
 *  live occurrence tally (0 when the world has none). Ordered by category then
 *  name so Camera/Light/… lead ahead of arbitrary components. */
export function getHierarchyFilterOptions(): readonly HierarchyFilterOption[] {
  const world = gateway.activeWorld;
  const counts = new Map<string, number>();
  if (world) {
    for (const entity of worldEntityHandles(world)) {
      for (const name of Object.keys(entComponents(world, entity))) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
  }
  return listComponentSchemas()
    .map((schema) => schema.name)
    .sort(compareComponentNames)
    .map((id) => ({ id, label: id, count: counts.get(id) ?? 0 }));
}

/** The single representative "type" shown in the type column, DERIVED from the
 *  entity's live components, in three priority tiers:
 *    1. intent components (anything not infra/Children) — highest; among them the
 *       CATEGORY_RULES-then-name winner's raw name IS the id (a Skylight node reads
 *       "Skylight", a Light+RigidBody node reads the light), so a brand-new
 *       component surfaces as its own type with no code change.
 *    2. Children (or a live child count) — the node is a 'group'.
 *    3. only infra (Transform/Name/…) or nothing — a bare 'entity'.
 *  So Transform/entity are the floor: any real component outranks them. */
export function getHierarchyEntityType(world: NonNullable<typeof gateway.activeWorld>, entity: EntityHandle): { id: string; label: string } {
  const components = Object.keys(entComponents(world, entity));
  const intent = components.filter((name) => name !== CHILDREN_COMPONENT && !LOW_TIER_COMPONENTS.has(name));
  if (intent.length > 0) {
    const id = intent.reduce((best, name) => (compareComponentNames(name, best) < 0 ? name : best));
    return { id, label: id };
  }
  if (components.includes(CHILDREN_COMPONENT) || childrenOf(world, entity).length > 0) {
    return { id: HIERARCHY_GROUP_TYPE_ID, label: 'Group' };
  }
  return { id: HIERARCHY_ENTITY_TYPE_ID, label: 'Entity' };
}

export function entityMatchesHierarchyView(id: EntityHandle): boolean {
  const world = gateway.activeWorld;
  if (!world) return false;
  const q = snapshot.searchQuery.trim().toLowerCase();
  const componentNames = Object.keys(entComponents(world, id));
  const type = getHierarchyEntityType(world, id);
  const passesSearch = !q
    || entName(world, id).toLowerCase().includes(q)
    || type.label.toLowerCase().includes(q)
    || componentNames.some((component) => component.toLowerCase().includes(q));
  if (!passesSearch) return false;
  // Filters are component names (multi-membership): an entity matches if it
  // carries ANY selected component. Structural group/folder rows are never
  // filtered out — filtering flattens the tree, so nested matches surface on
  // their own without needing their container to pass.
  if (snapshot.filters.size === 0) return true;
  return componentNames.some((name) => snapshot.filters.has(name));
}

export function getHierarchyVisibleMatches(): EntityHandle[] {
  const world = gateway.activeWorld;
  if (!world) return [];
  return worldEntityHandles(world).filter(entityMatchesHierarchyView);
}

export function hasHierarchyViewFilter(): boolean {
  return snapshot.searchQuery.trim() !== '' || snapshot.filters.size > 0;
}

export function getHierarchyParentEntities(): EntityHandle[] {
  const world = gateway.activeWorld;
  if (!world) return [];
  return worldEntityHandles(world).filter((id) => childrenOf(world, id).length > 0);
}
