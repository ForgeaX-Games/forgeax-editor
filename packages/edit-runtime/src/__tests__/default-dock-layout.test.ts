// @forgeax/editor/default-dock-layout — editor chrome layout SSOT regression.
//
// The layout deliberately owns its grouping/order, but every editor panel id
// must remain derived from the editor-core manifest. This catches a panel being
// added or removed without the default editor chrome following suit.
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_ASSET_EDITOR_DOCK_LAYOUT,
  DEFAULT_EDITOR_DOCK_LAYOUT,
  DEFAULT_MATERIAL_EDITOR_DOCK_LAYOUT,
  DEFAULT_MESH_EDITOR_DOCK_LAYOUT,
  DEFAULT_MI_EDITOR_DOCK_LAYOUT,
} from '../default-dock-layout';

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

type FooterDockGroup = {
  group: { views: readonly string[] };
  size: number;
};

describe('DEFAULT_EDITOR_DOCK_LAYOUT', () => {
  test('contains exactly the default main-grid dock panels', () => {
    const views = collectViews(DEFAULT_EDITOR_DOCK_LAYOUT.grid.root).sort();

    expect(views).toEqual(['chat', 'ep:hierarchy', 'ep:inspector', 'viewport']);
  });

  test('has a matching dockview panel descriptor for every view', () => {
    for (const id of collectViews(DEFAULT_EDITOR_DOCK_LAYOUT.grid.root)) {
      expect(DEFAULT_EDITOR_DOCK_LAYOUT.panels[id]).toBeDefined();
    }
  });

  test('gives the footer Content Browser enough height for its asset grid', () => {
    const footer = DEFAULT_EDITOR_DOCK_LAYOUT.edgeGroups?.bottom as FooterDockGroup | undefined;
    expect(footer?.group.views).toContain('ep:assets');
    expect(footer?.size).toBeGreaterThanOrEqual(280);
  });

  test('keeps global footer panels out of the main grid', () => {
    const footer = DEFAULT_EDITOR_DOCK_LAYOUT.edgeGroups?.bottom as FooterDockGroup | undefined;
    const footerViews = footer?.group.views;
    expect(footerViews).toEqual(['ep:assets', 'info', 'checkpoints', 'events']);
    expect(collectViews(DEFAULT_EDITOR_DOCK_LAYOUT.grid.root)).not.toContain('ep:assets');
    expect(collectViews(DEFAULT_EDITOR_DOCK_LAYOUT.grid.root)).not.toContain('ep:history');
    expect(collectViews(DEFAULT_EDITOR_DOCK_LAYOUT.grid.root)).not.toContain('ep:capabilities');
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
      'ep:mesh-preview',
      'ep:mesh-slots',
    ]);
    expect(DEFAULT_MESH_EDITOR_DOCK_LAYOUT.panels['ep:mesh-preview']).toBeDefined();
    expect(DEFAULT_MESH_EDITOR_DOCK_LAYOUT.panels['ep:mesh-slots']).toBeDefined();
    expect(DEFAULT_ASSET_EDITOR_DOCK_LAYOUT.panels['ep:mesh-slots']).toBeUndefined();
    expect(DEFAULT_EDITOR_DOCK_LAYOUT.panels['ep:mesh-slots']).toBeUndefined();
    expect(DEFAULT_MESH_EDITOR_DOCK_LAYOUT.panels['ep:mat-preview']).toBeUndefined();
  });
});

describe('DEFAULT_MI_EDITOR_DOCK_LAYOUT', () => {
  test('owns preview + properties panels independent of Level/Mesh', () => {
    expect(collectViews(DEFAULT_MI_EDITOR_DOCK_LAYOUT.grid.root).sort()).toEqual([
      'ep:mi-preview',
      'ep:mi-properties',
    ]);
    expect(DEFAULT_MI_EDITOR_DOCK_LAYOUT.panels['ep:mi-preview']).toBeDefined();
    expect(DEFAULT_MI_EDITOR_DOCK_LAYOUT.panels['ep:mi-properties']).toBeDefined();
    expect(DEFAULT_EDITOR_DOCK_LAYOUT.panels['ep:mi-preview']).toBeUndefined();
    expect(DEFAULT_MESH_EDITOR_DOCK_LAYOUT.panels['ep:mi-properties']).toBeUndefined();
  });
});

describe('DEFAULT_MATERIAL_EDITOR_DOCK_LAYOUT', () => {
  test('pairs the material preview viewport with properties + overview', () => {
    expect(collectViews(DEFAULT_MATERIAL_EDITOR_DOCK_LAYOUT.grid.root).sort()).toEqual([
      'ep:asset-overview',
      'ep:asset-properties',
      'ep:mat-preview',
    ]);
    for (const id of collectViews(DEFAULT_MATERIAL_EDITOR_DOCK_LAYOUT.grid.root)) {
      expect(DEFAULT_MATERIAL_EDITOR_DOCK_LAYOUT.panels[id]).toBeDefined();
    }
    // The preview panel belongs to the Material page alone — Level/Mesh/MI
    // layouts must not restore it.
    expect(DEFAULT_EDITOR_DOCK_LAYOUT.panels['ep:mat-preview']).toBeUndefined();
    expect(DEFAULT_MESH_EDITOR_DOCK_LAYOUT.panels['ep:mat-preview']).toBeUndefined();
    expect(DEFAULT_MI_EDITOR_DOCK_LAYOUT.panels['ep:mat-preview']).toBeUndefined();
  });
});
