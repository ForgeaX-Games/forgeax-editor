import { describe, expect, it } from 'bun:test';
import { gateway } from '@forgeax/editor-core';
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
    // The Material page owns its 3D preview panel (UE-style material editor);
    // the MI page keeps its own preview/properties pair.
    const matPanels = pages.find((page) => page.id.endsWith('/material'))?.panels.map((panel) => panel.id) ?? [];
    expect(matPanels).toContain('ep:mat-preview');
    expect(matPanels).toContain('ep:asset-properties');
    expect(matPanels).not.toContain('ep:mi-preview');
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
    // The generic page is the DEFAULT editor, not a hand-maintained kind list:
    // that list had rotted (it still claimed the retired `cube-texture` and
    // never covered equirect / animation-graph / video / particle-effect).
    const generic = editors.find((editor) => editor.pageTypeId === '@forgeax/editor#page/asset');
    expect(generic?.selector).toEqual({ fallback: true });
  });

  it('hands a double-clicked asset to the resolver, whatever its kind', async () => {
    // The regression this locks: openAsset used to pick the page itself with a
    // kind switch, which architecture.md forbids (ResourceEditorResolver owns
    // association > source layer > priority) and which silently hid the rotten
    // kind list above behind its own `return ASSET_PAGE` default.
    const opened: { kind?: string; canonicalId?: string }[] = [];
    const pageKey = { cardinality: 'resource', typeId: '@forgeax/editor#page/asset', resourceId: 'stub' };
    const host = {
      pages: {
        open: async () => pageKey,
        getSnapshot: () => ({ generation: 0, instances: [] }),
        subscribe: () => () => {},
      },
      resourceEditors: {
        open: async (resource: { kind?: string; canonicalId?: string }) => {
          opened.push(resource);
          return pageKey;
        },
      },
    };
    const extension = createEditorPageExtension(() => null);
    const dispose = await extension.setup?.({ host } as never);
    try {
      // 'mesh' has a dedicated page; 'particle-effect' is an engine kind nobody
      // declares. Both must reach the resolver identically.
      for (const kind of ['mesh', 'particle-effect']) {
        const result = gateway.dispatch({
          kind: 'openAssetEditor',
          asset: { guid: `guid-${kind}`, kind, name: `${kind}-asset`, payload: {}, packPath: 'assets/demo.pack.json' },
        } as never, 'human');
        expect(result.ok, kind).toBe(true);
      }
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    } finally {
      if (typeof dispose === 'function') dispose();
    }

    expect(opened.map((resource) => resource.kind)).toEqual(['mesh', 'particle-effect']);
    expect(opened.map((resource) => resource.canonicalId)).toEqual(['guid-mesh', 'guid-particle-effect']);
  });

  it('attaches a PageController factory to the material-instance page (M4/B2)', () => {
    const extension = createEditorPageExtension(() => null);
    const mi = extension.contributes?.pages?.find((page) => page.id.endsWith('/material-instance'));
    expect(typeof mi?.createController).toBe('function');
  });

  it('bumps the Material page layoutVersion so pre-preview snapshots are discarded', () => {
    // Regression: mat-preview was added to the Material page domain without a
    // version bump, so persisted page-layout snapshots from before the panel
    // existed were silently accepted (hasMountedPagePlacement passes as long
    // as ANY domain panel mounts) and the Preview never appeared — or came
    // back docked into a foreign group. The (pageTypeId, layoutVersion) key
    // must change whenever the page's panel set / default arrangement does.
    const extension = createEditorPageExtension(() => null);
    const pages = extension.contributes?.pages ?? [];
    const material = pages.find((page) => page.id.endsWith('/material'));
    expect(material?.layoutVersion).toBe(2);
    for (const suffix of ['/level', '/asset', '/mesh', '/material-instance']) {
      const page = pages.find((candidate) => candidate.id.endsWith(suffix));
      expect(page?.layoutVersion ?? 1, suffix).toBe(1);
    }
  });
});
