import { describe, expect, it } from 'bun:test';
import { createEditorPageExtension } from './page-extension';

describe('Editor Page contribution', () => {
  it('registers Level, generic asset, mesh, and material in the shared Page model', () => {
    const extension = createEditorPageExtension(() => null);
    const pages = extension.contributes?.pages ?? [];

    expect(pages.map((page) => [page.id, page.cardinality])).toEqual([
      ['@forgeax/editor#page/level', 'singleton'],
      ['@forgeax/editor#page/asset', 'resource'],
      ['@forgeax/editor#page/mesh', 'resource'],
      ['@forgeax/editor#page/material', 'resource'],
    ]);
    expect(pages.find((page) => page.id.endsWith('/mesh'))?.panels.map((panel) => panel.id))
      .toContain('ep:mesh-slots');
    expect(pages.find((page) => page.id.endsWith('/material'))?.panels.map((panel) => panel.id))
      .not.toContain('ep:mesh-slots');
  });

  it('routes asset kinds through ResourceEditor contributions without a shell switch', () => {
    const extension = createEditorPageExtension(() => null);
    const editors = extension.contributes?.resourceEditors ?? [];

    expect(editors.find((editor) => editor.selector.kinds?.includes('mesh'))?.pageTypeId)
      .toBe('@forgeax/editor#page/mesh');
    expect(editors.find((editor) => editor.selector.kinds?.includes('material'))?.pageTypeId)
      .toBe('@forgeax/editor#page/material');
  });
});
