// @forgeax/editor/default-dock-layout — editor chrome layout SSOT regression.
//
// The layout deliberately owns its grouping/order, but every editor panel id
// must remain derived from the editor-core manifest. This catches a panel being
// added or removed without the default editor chrome following suit.
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_ASSET_EDITOR_DOCK_LAYOUT,
  DEFAULT_EDITOR_DOCK_LAYOUT,
  DEFAULT_MESH_EDITOR_DOCK_LAYOUT,
} from './default-dock-layout';

function collectViews(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  const item = node as { type?: string; data?: unknown };
  if (item.type === 'leaf') {
    const data = item.data as { views?: unknown } | undefined;
    return Array.isArray(data?.views) ? data.views.filter((view): view is string => typeof view === 'string') : [];
  }
  if (item.type === 'branch' && Array.isArray(item.data)) {
    return item.data.flatMap(collectViews);
  }
  return [];
}

function findLeaf(node: unknown, view: string): { size?: number } | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const item = node as { type?: string; data?: unknown; size?: number };
  if (item.type === 'leaf') {
    const data = item.data as { views?: unknown } | undefined;
    return Array.isArray(data?.views) && data.views.includes(view) ? item : undefined;
  }
  if (item.type === 'branch' && Array.isArray(item.data)) {
    for (const child of item.data) {
      const found = findLeaf(child, view);
      if (found) return found;
    }
  }
  return undefined;
}

function leafViews(node: unknown, view: string): string[] | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const item = node as { type?: string; data?: unknown };
  if (item.type === 'leaf') {
    const data = item.data as { views?: unknown } | undefined;
    const views = Array.isArray(data?.views) ? data.views.filter((entry): entry is string => typeof entry === 'string') : [];
    return views.includes(view) ? views : undefined;
  }
  if (item.type === 'branch' && Array.isArray(item.data)) {
    for (const child of item.data) {
      const found = leafViews(child, view);
      if (found) return found;
    }
  }
  return undefined;
}

describe('DEFAULT_EDITOR_DOCK_LAYOUT', () => {
  test('contains exactly the default visible dock panels', () => {
    const views = collectViews(DEFAULT_EDITOR_DOCK_LAYOUT.grid.root).sort();

    expect(views).toEqual(['chat', 'ep:assets', 'ep:hierarchy', 'ep:history', 'ep:inspector', 'info', 'viewport']);
  });

  test('has a matching dockview panel descriptor for every view', () => {
    for (const id of collectViews(DEFAULT_EDITOR_DOCK_LAYOUT.grid.root)) {
      expect(DEFAULT_EDITOR_DOCK_LAYOUT.panels[id]).toBeDefined();
    }
  });

  test('gives the Content Browser enough height for its asset grid', () => {
    const assets = findLeaf(DEFAULT_EDITOR_DOCK_LAYOUT.grid.root, 'ep:assets');
    expect(assets?.size).toBeGreaterThanOrEqual(280);
  });

  test('groups History with Content Browser and Info', () => {
    expect(leafViews(DEFAULT_EDITOR_DOCK_LAYOUT.grid.root, 'ep:assets')).toEqual([
      'ep:assets',
      'info',
      'ep:history',
    ]);
  });
});

describe('DEFAULT_ASSET_EDITOR_DOCK_LAYOUT', () => {
  test('is a separate closed panel domain from Level', () => {
    expect(collectViews(DEFAULT_ASSET_EDITOR_DOCK_LAYOUT.grid.root).sort()).toEqual([
      'ep:asset-overview',
      'ep:asset-properties',
    ]);
    expect(DEFAULT_EDITOR_DOCK_LAYOUT.panels['ep:asset-overview']).toBeUndefined();
    expect(DEFAULT_EDITOR_DOCK_LAYOUT.panels['ep:asset-properties']).toBeUndefined();
  });

  test('mesh pages alone own the material-slot panel', () => {
    expect(collectViews(DEFAULT_MESH_EDITOR_DOCK_LAYOUT.grid.root).sort()).toEqual([
      'ep:asset-overview',
      'ep:asset-properties',
      'ep:mesh-slots',
    ]);
    expect(DEFAULT_MESH_EDITOR_DOCK_LAYOUT.panels['ep:mesh-slots']).toBeDefined();
    expect(DEFAULT_ASSET_EDITOR_DOCK_LAYOUT.panels['ep:mesh-slots']).toBeUndefined();
    expect(DEFAULT_EDITOR_DOCK_LAYOUT.panels['ep:mesh-slots']).toBeUndefined();
  });
});
