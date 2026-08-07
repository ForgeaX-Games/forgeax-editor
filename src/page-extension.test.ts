import { describe, expect, it } from 'bun:test';
import { createEditorPageExtension } from './page-extension';

describe('Editor Page contribution', () => {
  it('registers Level, generic asset, mesh, material, and material-instance in the shared Page model', () => {
    const extension = createEditorPageExtension(() => null);
    const pages = extension.contributes?.pages ?? [];

    expect(pages.map((page) => [page.id, page.cardinality])).toEqual([
      ['@forgeax/editor#page/level', 'singleton'],
      ['@forgeax/editor#page/asset', 'resource'],
      ['@forgeax/editor#page/mesh', 'resource'],
      ['@forgeax/editor#page/material', 'resource'],
      ['@forgeax/editor#page/material-instance', 'resource'],
    ]);
    const level = pages.find((page) => page.id.endsWith('/level'));
    expect(level?.panels.map((panel) => panel.id)).toContain('ep:capabilities');
    expect(pages.find((page) => page.id.endsWith('/mesh'))?.panels.map((panel) => panel.id))
      .toContain('ep:mesh-slots');
    expect(pages.find((page) => page.id.endsWith('/material'))?.panels.map((panel) => panel.id))
      .not.toContain('ep:mesh-slots');
    const miPanels = pages.find((page) => page.id.endsWith('/material-instance'))?.panels.map((panel) => panel.id) ?? [];
    expect(miPanels).toContain('ep:mi-preview');
    expect(miPanels).toContain('ep:mi-properties');
    expect(miPanels).not.toContain('ep:mesh-slots');
  });

  it('keeps the chrome Settings panel inside every editor page panel domain', () => {
    // Regression: the standalone TopBar gear redirects to panel:open
    // 'ep:settings' — DockRegion.isMember drops the event when the active
    // page's closed panel domain lacks the id, so the button looked dead.
    const extension = createEditorPageExtension(() => null);
    const pages = extension.contributes?.pages ?? [];
    for (const suffix of ['/level', '/asset', '/mesh', '/material', '/material-instance']) {
      const page = pages.find((candidate) => candidate.id.endsWith(suffix));
      expect(page?.panels.map((panel) => panel.id), suffix).toContain('ep:settings');
    }
    // …and its panel TYPE must be registered, or the dock cannot render it.
    const panelTypes = extension.contributes?.panelTypes ?? [];
    expect(panelTypes.map((panel) => panel.id)).toContain('@forgeax/editor#panel/settings');
  });

  it('routes asset kinds through ResourceEditor contributions without a shell switch', () => {
    const extension = createEditorPageExtension(() => null);
    const editors = extension.contributes?.resourceEditors ?? [];

    expect(editors.find((editor) => editor.selector.kinds?.includes('mesh'))?.pageTypeId)
      .toBe('@forgeax/editor#page/mesh');
    expect(editors.find((editor) => editor.selector.kinds?.includes('material'))?.pageTypeId)
      .toBe('@forgeax/editor#page/material');
    expect(editors.find((editor) => editor.selector.kinds?.includes('material-instance'))?.pageTypeId)
      .toBe('@forgeax/editor#page/material-instance');
  });

  it('attaches a PageController factory to the material-instance page (M4/B2)', () => {
    const extension = createEditorPageExtension(() => null);
    const mi = extension.contributes?.pages?.find((page) => page.id.endsWith('/material-instance'));
    expect(typeof mi?.createController).toBe('function');
  });
});
