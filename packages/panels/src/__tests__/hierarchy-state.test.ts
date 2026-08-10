import { afterEach, describe, expect, it } from 'bun:test';
import { gateway } from '@forgeax/editor-core';

import {
  HIERARCHY_ENTITY_TYPE_ID,
  HIERARCHY_GROUP_TYPE_ID,
  HIERARCHY_SCENE_FOLDER_ID,
  clearHierarchyFilters,
  clearHierarchySearchQuery,
  collapseHierarchyAll,
  componentTypeLabel,
  expandHierarchyAll,
  expandHierarchySceneFolder,
  getHierarchyEntityType,
  getHierarchyFilterOptions,
  getHierarchyPanelSnapshot,
  getHierarchyParentEntities,
  getHierarchyVisibleMatches,
  hasHierarchyViewFilter,
  hierarchyTypeCategory,
  resetHierarchyViewState,
  setHierarchySearchQuery,
  subscribeHierarchyPanelState,
  toggleHierarchyCollapseAll,
  toggleHierarchyCollapsed,
  toggleHierarchyColumn,
  toggleHierarchyFilter,
} from '../hierarchy-state';

// hierarchy-state owns a module-global view snapshot + localStorage-backed
// collapse set. Reset both to defaults after each test so the shared state never
// leaks into the other hierarchy tests in this package.
afterEach(() => {
  resetHierarchyViewState();
  clearHierarchyFilters();
  clearHierarchySearchQuery();
  expandHierarchyAll();
});

describe('hierarchyTypeCategory', () => {
  it('maps structural ids and component-name patterns to a cosmetic category', () => {
    expect(hierarchyTypeCategory(HIERARCHY_GROUP_TYPE_ID)).toBe('group');
    expect(hierarchyTypeCategory(HIERARCHY_ENTITY_TYPE_ID)).toBe('entity');
    expect(hierarchyTypeCategory('CineCamera')).toBe('camera');
    expect(hierarchyTypeCategory('PointLight')).toBe('light');
    expect(hierarchyTypeCategory('CharacterController')).toBe('character');
    expect(hierarchyTypeCategory('PlayerStart')).toBe('start');
    expect(hierarchyTypeCategory('EnemySpawner')).toBe('spawner');
    expect(hierarchyTypeCategory('MeshRenderer')).toBe('mesh');
    expect(hierarchyTypeCategory('Whatever')).toBe('generic');
  });
});

describe('componentTypeLabel', () => {
  it('returns the translation when present and the raw id on a miss', () => {
    const translate = (key: string) => (key === 'editor.hierarchy.types.Transform' ? 'Transform (localized)' : key);
    expect(componentTypeLabel('Transform', translate)).toBe('Transform (localized)');
    // A t() that echoes the key (miss) falls back to the raw component name.
    expect(componentTypeLabel('BrandNewComponent', (key) => key)).toBe('BrandNewComponent');
  });
});

describe('getHierarchyEntityType', () => {
  const world = gateway.activeWorld as NonNullable<typeof gateway.activeWorld>;

  it('picks the highest-priority intent component as the representative type', () => {
    // Light beats a generic RigidBody per CATEGORY_RULES ordering.
    const type = getHierarchyEntityType(['Transform', 'RigidBody', 'PointLight'], world, 0 as never);
    expect(type.id).toBe('PointLight');
    expect(type.label).toBe('PointLight');
  });

  it('reads a Children-bearing infra-only node as a group', () => {
    const type = getHierarchyEntityType(['Transform', 'Name', 'Children'], world, 0 as never);
    expect(type.id).toBe(HIERARCHY_GROUP_TYPE_ID);
  });
});

describe('view-state mutators', () => {
  it('search query set/clear notifies subscribers and is a no-op when already empty', () => {
    let notifications = 0;
    const unsubscribe = subscribeHierarchyPanelState(() => { notifications += 1; });

    setHierarchySearchQuery('hero');
    expect(getHierarchyPanelSnapshot().searchQuery).toBe('hero');
    expect(hasHierarchyViewFilter()).toBe(true);

    clearHierarchySearchQuery();
    expect(getHierarchyPanelSnapshot().searchQuery).toBe('');

    const settled = notifications;
    clearHierarchySearchQuery(); // already empty → no emit
    expect(notifications).toBe(settled);

    unsubscribe();
    setHierarchySearchQuery('after-unsub');
    expect(notifications).toBe(settled); // listener detached
  });

  it('toggles a component filter on and off', () => {
    expect(hasHierarchyViewFilter()).toBe(false);
    toggleHierarchyFilter('PointLight');
    expect(getHierarchyPanelSnapshot().filters.has('PointLight')).toBe(true);
    expect(hasHierarchyViewFilter()).toBe(true);
    toggleHierarchyFilter('PointLight');
    expect(getHierarchyPanelSnapshot().filters.has('PointLight')).toBe(false);

    // clearHierarchyFilters is a no-op when nothing is selected.
    const before = getHierarchyPanelSnapshot();
    clearHierarchyFilters();
    expect(getHierarchyPanelSnapshot()).toBe(before);
  });

  it('toggles a column and resets the whole view state', () => {
    expect(getHierarchyPanelSnapshot().columns.mobility).toBe(false);
    toggleHierarchyColumn('mobility');
    expect(getHierarchyPanelSnapshot().columns.mobility).toBe(true);

    toggleHierarchyFilter('MeshRenderer');
    setHierarchySearchQuery('x');
    resetHierarchyViewState();
    const snapshot = getHierarchyPanelSnapshot();
    expect(snapshot.searchQuery).toBe('');
    expect(snapshot.filters.size).toBe(0);
    expect(snapshot.columns.mobility).toBe(false);
  });

  it('collapses/expands entities and the scene-folder root through the persisted set', () => {
    toggleHierarchyCollapsed(42 as never);
    expect(getHierarchyPanelSnapshot().collapsed.has(42 as never)).toBe(true);
    toggleHierarchyCollapsed(42 as never);
    expect(getHierarchyPanelSnapshot().collapsed.has(42 as never)).toBe(false);

    toggleHierarchyCollapsed(HIERARCHY_SCENE_FOLDER_ID);
    expect(getHierarchyPanelSnapshot().collapsed.has(HIERARCHY_SCENE_FOLDER_ID)).toBe(true);
    expandHierarchySceneFolder();
    expect(getHierarchyPanelSnapshot().collapsed.has(HIERARCHY_SCENE_FOLDER_ID)).toBe(false);

    const settled = getHierarchyPanelSnapshot();
    expandHierarchySceneFolder(); // root already expanded → no-op
    expect(getHierarchyPanelSnapshot()).toBe(settled);

    // Collapse-all over an empty world collapses no parents; toggle then expands.
    toggleHierarchyCollapseAll();
    expect(getHierarchyPanelSnapshot().collapsed.size).toBe(0);
    collapseHierarchyAll();
    expect(getHierarchyPanelSnapshot().collapsed.size).toBe(0);
  });
});

describe('world-backed reads over the active world', () => {
  it('returns array structural reads and a code-derived filter option list', () => {
    // The gateway world is shared, mutable process state, so assert on shape
    // rather than emptiness (another suite may have populated it first).
    expect(Array.isArray(getHierarchyParentEntities())).toBe(true);
    expect(Array.isArray(getHierarchyVisibleMatches())).toBe(true);

    const options = getHierarchyFilterOptions();
    expect(options.length).toBeGreaterThan(0);
    // Options come from the registry: id === label and a non-negative live count.
    expect(options.every((option) => option.id === option.label && option.count >= 0)).toBe(true);
  });
});
