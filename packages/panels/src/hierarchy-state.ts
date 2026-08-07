import {
  childrenOf,
  entName,
  entParent,
  entComponentsPresent,
  gateway,
  listComponentSchemas,
  worldComponentNames,
  worldEntityHandles,
  type EntityHandle,
  type RuntimeUiGraph,
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

export interface HierarchyEntitySummary {
  readonly id: EntityHandle;
  readonly name: string;
  readonly typeId: string;
  readonly hidden?: boolean;
  /** UE-parity recursive hide: at least one strict ancestor carries EditorHidden.
   *  The row dims (lighter than own-hidden) and the viewport already skips the
   *  subtree — derived here so panels never walk ChildOf per render. */
  readonly ancestorHidden?: boolean;
  readonly mobility: 'static' | 'movable' | 'stationary' | '';
  readonly childIds: readonly EntityHandle[];
}

export interface HierarchyStructureProjection {
  readonly structureEpoch: number;
  readonly rows: readonly HierarchyEntitySummary[];
}

export interface HierarchyStructureSelector {
  mount(): {
    getSnapshot(): HierarchyStructureProjection | undefined;
    subscribe(listener: () => void): () => void;
    unsubscribe(): void;
  };
  stats(): { readonly projectionRebuilds: number };
  resolveSelection(id: EntityHandle):
    | { readonly ok: true; readonly id: EntityHandle }
    | { readonly ok: false; readonly code: 'stale-entity-selection'; readonly retryable: true };
}

type StructureReader = (world: unknown) => HierarchyStructureProjection;

/**
 * Derive the hierarchy mobility label from the component schema facts.
 *
 * `RigidBody.type` is the physics producer's numeric enum: static bodies are
 * fixed/stationary, while dynamic and kinematic bodies are user/game driven.
 * The previous presence-only fallback labelled every RigidBody as movable,
 * which made a static physics ground misleading in the human hierarchy.
 */
export function hierarchyMobility(components: Record<string, unknown>): HierarchyEntitySummary['mobility'] {
  const explicit = Object.values(components)
    .map((component) => {
      if (typeof component !== 'object' || component === null) return undefined;
      const value = (component as { mobility?: unknown; Mobility?: unknown }).mobility
        ?? (component as { mobility?: unknown; Mobility?: unknown }).Mobility;
      return typeof value === 'string' ? value.toLowerCase() : undefined;
    })
    .find(Boolean);
  if (explicit === 'static' || explicit === 'movable' || explicit === 'stationary') return explicit;
  const rigidBody = components.RigidBody ?? components.Rigidbody;
  if (typeof rigidBody === 'object' && rigidBody !== null && !Array.isArray(rigidBody)) {
    const type = (rigidBody as { type?: unknown }).type;
    if (type === 0) return 'stationary';
    if (type === 1 || type === 2) return 'movable';
  }
  if ('RigidBody' in components || 'Rigidbody' in components) return 'movable';
  if ('Transform' in components) return 'static';
  return '';
}

function readWorldStructure(world: unknown): HierarchyStructureProjection {
  const typedWorld = world as Parameters<typeof worldEntityHandles>[0];
  const structureEpoch = typeof (typedWorld as { getStructureEpoch?: unknown }).getStructureEpoch === 'function'
    ? Number((typedWorld as { getStructureEpoch: () => number }).getStructureEpoch())
    : 0;
  const namesByEntity = worldComponentNames(typedWorld);
  const rows = worldEntityHandles(typedWorld).map((id) => {
    const names = namesByEntity.get(id) ?? [];
    return {
      id,
      name: entName(typedWorld, id),
      typeId: getHierarchyEntityType(names, typedWorld, id).id,
      hidden: names.includes('EditorHidden'),
      mobility: hierarchyMobility(entComponentsPresent(typedWorld, id, names)),
      childIds: childrenOf(typedWorld, id),
    };
  });
  // Recursive-hide derivation (UE parity §1): parent map from childIds, then a
  // memoized walk so each row knows whether an ANCESTOR hides it. One O(n) pass —
  // cheaper than walking ChildOf per row per render.
  const parentOf = new Map<EntityHandle, EntityHandle>();
  const hiddenSet = new Set<EntityHandle>();
  for (const row of rows) {
    if (row.hidden) hiddenSet.add(row.id);
    for (const child of row.childIds) parentOf.set(child, row.id);
  }
  const ancestorHiddenCache = new Map<EntityHandle, boolean>();
  const visiting = new Set<EntityHandle>();
  const isAncestorHidden = (id: EntityHandle): boolean => {
    const cached = ancestorHiddenCache.get(id);
    if (cached !== undefined) return cached;
    const parent = parentOf.get(id);
    if (parent === undefined) {
      ancestorHiddenCache.set(id, false);
      return false;
    }
    if (hiddenSet.has(parent) || visiting.has(parent)) {
      ancestorHiddenCache.set(id, hiddenSet.has(parent));
      return hiddenSet.has(parent);
    }
    visiting.add(id);
    const result = isAncestorHidden(parent);
    visiting.delete(id);
    ancestorHiddenCache.set(id, result);
    return result;
  };
  return {
    structureEpoch,
    rows: Object.freeze(rows.map((row) => ({ ...row, ancestorHidden: isAncestorHidden(row.id) }))),
  };
}

export function createHierarchyStructureSelector(graph: RuntimeUiGraph, reader: StructureReader = readWorldStructure): HierarchyStructureSelector {
  let projection: HierarchyStructureProjection | undefined;
  let projectionRebuilds = 0;
  let mounted = 0;
  const mountedSelector = graph.mount({
    key: 'panels.hierarchy.structure',
    schema: {
      kind: 'pod',
      fields: {
        structureEpoch: { kind: 'primitive' },
        rows: { kind: 'array', item: { kind: 'pod', fields: {
          id: { kind: 'primitive' }, name: { kind: 'primitive' }, typeId: { kind: 'primitive' }, hidden: { kind: 'primitive' },
          ancestorHidden: { kind: 'primitive' },
          mobility: { kind: 'primitive' }, childIds: { kind: 'array', item: { kind: 'primitive' } },
        } } },
      },
    },
    read: (world) => {
      const next = reader(world);
      if (projection?.structureEpoch === next.structureEpoch) return projection;
      projection = { structureEpoch: next.structureEpoch, rows: next.rows };
      projectionRebuilds += 1;
      return projection;
    },
  });
  return {
    mount() {
      mounted += 1;
      let released = false;
      return {
        getSnapshot: () => mountedSelector.getSnapshot(),
        subscribe: (listener) => mountedSelector.subscribe(listener),
        unsubscribe: () => {
          if (released) return;
          released = true;
          mounted -= 1;
          if (mounted === 0) mountedSelector.unsubscribe();
        },
      };
    },
    stats: () => ({ projectionRebuilds }),
    resolveSelection: (id) => projection?.rows.some((row) => row.id === id)
      ? { ok: true, id }
      : { ok: false, code: 'stale-entity-selection', retryable: true },
  };
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
  mobility: false,
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

/** Expand the virtual "Scene" root folder. Called when a scene is (re)loaded or
 *  switched so the freshly loaded contents are never hidden behind a persisted
 *  collapse of the root — the root's collapse is a per-session convenience, not a
 *  reason to open onto an empty-looking tree after a load. No-op (no emit / no
 *  localStorage write) when the root is already expanded, so it is safe to call
 *  on every scene-identity change. */
export function expandHierarchySceneFolder(): void {
  if (!snapshot.collapsed.has(HIERARCHY_SCENE_FOLDER_ID)) return;
  const collapsed = new Set(snapshot.collapsed);
  collapsed.delete(HIERARCHY_SCENE_FOLDER_ID);
  saveCollapsed(collapsed);
  nextSnapshot({ ...snapshot, collapsed });
}

export function collapseHierarchyAll(): void {
  // Collapse every group entity but keep the Scene root folder expanded, so the
  // top-level entities under Scene stay visible (e.g. Scene → Player collapsed),
  // instead of hiding everything behind a single collapsed "Scene" row.
  const collapsed = new Set(getHierarchyParentEntities());
  saveCollapsed(collapsed);
  nextSnapshot({ ...snapshot, collapsed });
}

export function toggleHierarchyCollapseAll(): void {
  const parents = getHierarchyParentEntities();
  const allCollapsed = parents.length > 0 && parents.every((id) => snapshot.collapsed.has(id));
  if (allCollapsed) expandHierarchyAll();
  else collapseHierarchyAll();
}

/** Expand all ancestors of `id` so it becomes visible in the tree. Also
 *  expands the scene-folder root if it was collapsed. */
export function revealHierarchyEntity(id: EntityHandle): void {
  const world = gateway.activeWorld;
  if (!world) return;
  const toExpand: EntityHandle[] = [];
  let cur = entParent(world, id);
  while (cur !== null) {
    if (snapshot.collapsed.has(cur)) toExpand.push(cur);
    cur = entParent(world, cur);
  }
  if (snapshot.collapsed.has(HIERARCHY_SCENE_FOLDER_ID)) {
    toExpand.push(HIERARCHY_SCENE_FOLDER_ID);
  }
  if (toExpand.length === 0) return;
  const collapsed = new Set(snapshot.collapsed);
  for (const ancestor of toExpand) collapsed.delete(ancestor);
  saveCollapsed(collapsed);
  nextSnapshot({ ...snapshot, collapsed });
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
    // Structural name index (zero Error) instead of per-entity entComponents probe.
    for (const names of worldComponentNames(world).values()) {
      for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
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
export function getHierarchyEntityType(
  componentNames: readonly string[],
  world: NonNullable<typeof gateway.activeWorld>,
  entity: EntityHandle,
): { id: string; label: string } {
  const intent = componentNames.filter((name) => name !== CHILDREN_COMPONENT && !LOW_TIER_COMPONENTS.has(name));
  if (intent.length > 0) {
    const id = intent.reduce((best, name) => (compareComponentNames(name, best) < 0 ? name : best));
    return { id, label: id };
  }
  if (componentNames.includes(CHILDREN_COMPONENT) || childrenOf(world, entity).length > 0) {
    return { id: HIERARCHY_GROUP_TYPE_ID, label: 'Group' };
  }
  return { id: HIERARCHY_ENTITY_TYPE_ID, label: 'Entity' };
}

/** Does entity `id` (whose component names are `componentNames`) pass the current
 *  search + filter view? Component names are passed in (from the caller's
 *  worldComponentNames index) so this never re-probes the world per entity. */
export function entityMatchesHierarchyView(
  world: NonNullable<typeof gateway.activeWorld>,
  id: EntityHandle,
  componentNames: readonly string[],
): boolean {
  const q = snapshot.searchQuery.trim().toLowerCase();
  const type = getHierarchyEntityType(componentNames, world, id);
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
  // One structural name index for the whole world (zero Error), reused for every
  // candidate instead of an entComponents probe per entity.
  const index = worldComponentNames(world);
  return worldEntityHandles(world).filter((id) => entityMatchesHierarchyView(world, id, index.get(id) ?? []));
}

export function hasHierarchyViewFilter(): boolean {
  return snapshot.searchQuery.trim() !== '' || snapshot.filters.size > 0;
}

export function getHierarchyParentEntities(): EntityHandle[] {
  const world = gateway.activeWorld;
  if (!world) return [];
  return worldEntityHandles(world).filter((id) => childrenOf(world, id).length > 0);
}
