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

describe('DEFAULT_EDITOR_DOCK_LAYOUT', () => {
  test('contains exactly the default visible dock panels', () => {
    const views = collectViews(DEFAULT_EDITOR_DOCK_LAYOUT.grid.root).sort();

    expect(views).toEqual(['chat', 'ep:assets', 'ep:hierarchy', 'ep:inspector', 'info', 'viewport']);
  });

  test('has a matching dockview panel descriptor for every view', () => {
    for (const id of collectViews(DEFAULT_EDITOR_DOCK_LAYOUT.grid.root)) {
      expect(DEFAULT_EDITOR_DOCK_LAYOUT.panels[id]).toBeDefined();
    }
  });
});
