// @forgeax/editor/default-dock-layout — editor chrome layout SSOT regression.
//
// The layout deliberately owns its grouping/order, but every editor panel id
// must remain derived from the editor-core manifest. This catches a panel being
// added or removed without the default editor chrome following suit.
import { describe, expect, test } from 'bun:test';
import { DEFAULT_EDITOR_DOCK_LAYOUT } from './default-dock-layout';

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

describe('DEFAULT_EDITOR_DOCK_LAYOUT', () => {
  test('contains exactly the default visible dock panels', () => {
    const views = collectViews(DEFAULT_EDITOR_DOCK_LAYOUT.grid.root).sort();

    expect(views).toEqual(['chat', 'ep:asset-inspector', 'ep:assets', 'ep:hierarchy', 'ep:history', 'ep:inspector', 'info', 'viewport']);
  });

  test('has a matching dockview panel descriptor for every view', () => {
    for (const id of collectViews(DEFAULT_EDITOR_DOCK_LAYOUT.grid.root)) {
      expect(DEFAULT_EDITOR_DOCK_LAYOUT.panels[id]).toBeDefined();
    }
  });

  test('gives the Content Browser enough height for its wrapped entry bar', () => {
    const assets = findLeaf(DEFAULT_EDITOR_DOCK_LAYOUT.grid.root, 'ep:assets');
    const history = findLeaf(DEFAULT_EDITOR_DOCK_LAYOUT.grid.root, 'ep:history');
    expect(assets?.size).toBeGreaterThanOrEqual(280);
    expect(assets?.size).toBeGreaterThan(history?.size ?? 0);
  });
});
