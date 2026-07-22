import {
  childrenOf,
  entComponents,
  entName,
  gateway,
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

const TYPE_FILTERS: readonly Omit<HierarchyFilterOption, 'count'>[] = [
  { id: 'character', label: 'Character' },
  { id: 'mesh', label: 'Static Mesh' },
  { id: 'light', label: 'Light' },
  { id: 'camera', label: 'Camera' },
  { id: 'start', label: 'Player Start' },
  { id: 'spawner', label: 'Spawner' },
];

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

export function getHierarchyFilterOptions(): readonly HierarchyFilterOption[] {
  const world = gateway.activeWorld;
  const counts = new Map<string, number>();
  if (world) {
    for (const entity of worldEntityHandles(world)) {
      const type = getHierarchyEntityType(world, entity);
      counts.set(type.id, (counts.get(type.id) ?? 0) + 1);
    }
  }
  return TYPE_FILTERS.map((option) => ({ ...option, count: counts.get(option.id) ?? 0 }));
}

export function getHierarchyEntityType(world: NonNullable<typeof gateway.activeWorld>, entity: EntityHandle): { id: string; label: string } {
  const components = Object.keys(entComponents(world, entity));
  const childCount = childrenOf(world, entity).length;
  if (components.some((name) => name.includes('Camera'))) return { id: 'camera', label: 'Camera' };
  if (components.some((name) => name.includes('Light'))) return { id: 'light', label: 'Light' };
  if (components.some((name) => name.includes('Character') || name.includes('Controller'))) return { id: 'character', label: 'Character' };
  if (components.some((name) => name.includes('PlayerStart'))) return { id: 'start', label: 'Player Start' };
  if (components.some((name) => name.includes('Spawner'))) return { id: 'spawner', label: 'Spawner' };
  if (components.some((name) => name.includes('Mesh'))) return { id: 'mesh', label: 'Static Mesh' };
  if (childCount > 0) return { id: 'group', label: 'Group' };
  return { id: 'entity', label: 'Entity' };
}

export function entityMatchesHierarchyView(id: EntityHandle): boolean {
  const world = gateway.activeWorld;
  if (!world) return false;
  const q = snapshot.searchQuery.trim().toLowerCase();
  const components = Object.keys(entComponents(world, id));
  const type = getHierarchyEntityType(world, id);
  const passesSearch = !q
    || entName(world, id).toLowerCase().includes(q)
    || type.label.toLowerCase().includes(q)
    || components.some((component) => component.toLowerCase().includes(q));
  if (!passesSearch) return false;
  if (snapshot.filters.size === 0) return true;
  return snapshot.filters.has(type.id);
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
