import { describe, expect, it } from 'bun:test';
import {
  closeInputMapStaging,
  createDefaultInputMapPayload,
  gateway,
  getActiveEditorAsset,
  openInputMapStaging,
  renameInputMapStaging,
} from '@forgeax/editor-core';
import { broadcastAssetsChanged } from '../../../core/src/store/assets-changed';
import { createEditorPageExtension } from '../page-extension';

describe('Editor Page contribution', () => {
  it('registers Level and dedicated asset workbenches in the shared Page model', () => {
    const extension = createEditorPageExtension(() => null);
    const pages = extension.contributes?.pages ?? [];

    expect(pages.map((page) => [page.id, page.cardinality])).toEqual([
      ['@forgeax/editor#page/level', 'singleton'],
      ['@forgeax/editor#page/asset', 'resource'],
      ['@forgeax/editor#page/mesh', 'resource'],
      ['@forgeax/editor#page/material', 'resource'],
      ['@forgeax/editor#page/material-instance', 'resource'],
      ['@forgeax/editor#page/input-map', 'resource'],
      ['@forgeax/editor#page/vfx', 'resource'],
    ]);
    const level = pages.find((page) => page.id.endsWith('/level'));
    expect(level?.panels.map((panel) => panel.id)).toContain('ep:capabilities');
    const meshPanels = pages.find((page) => page.id.endsWith('/mesh'))?.panels.map((panel) => panel.id) ?? [];
    expect(meshPanels).toContain('ep:mesh-preview');
    expect(meshPanels).toContain('ep:mesh-slots');
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
    const inputMapPanels = pages.find((page) => page.id.endsWith('/input-map'))?.panels.map((panel) => panel.id) ?? [];
    expect(inputMapPanels).toContain('ep:input-map-properties');
    expect(inputMapPanels).not.toContain('ep:mi-preview');
    const vfxPanels = pages.find((page) => page.id.endsWith('/vfx'))?.panels.map((panel) => panel.id) ?? [];
    expect(vfxPanels).toEqual(expect.arrayContaining([
      'ep:vfx-system', 'ep:vfx-preview', 'ep:vfx-timeline', 'ep:vfx-details', 'ep:vfx-diagnostics',
    ]));
    expect(vfxPanels).not.toContain('ep:asset-properties');
  });

  it('keeps the chrome Settings panel inside every editor page panel domain', () => {
    // Regression: the standalone TopBar gear redirects to panel:open
    // 'ep:settings' — DockRegion.isMember drops the event when the active
    // page's closed panel domain lacks the id, so the button looked dead.
    const extension = createEditorPageExtension(() => null);
    const pages = extension.contributes?.pages ?? [];
    for (const suffix of ['/level', '/asset', '/mesh', '/material', '/material-instance', '/input-map', '/vfx']) {
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
    expect(editors.find((editor) => editor.selector.kinds?.includes('input-map'))?.pageTypeId)
      .toBe('@forgeax/editor#page/input-map');
    expect(editors.find((editor) => editor.selector.kinds?.includes('particle-effect'))?.pageTypeId)
      .toBe('@forgeax/editor#page/vfx');
    // The generic page is the DEFAULT editor, not a hand-maintained kind list:
    // that list had rotted (it still claimed the retired `cube-texture` and
    // never covered equirect / animation-graph / video).
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
      // Both dedicated kinds must still reach the resolver identically; the
      // ResourceEditor contribution, not this caller, chooses their pages.
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

  it('derives an open Input Map name from staging and closes its page after deletion lands', async () => {
    const guid = '22222222-2222-4222-8222-222222222222';
    const key = {
      cardinality: 'resource',
      typeId: '@forgeax/editor#page/input-map',
      resourceId: guid,
    };
    const encodedKey = 'input-map-page';
    const closed: Array<{ key: unknown; request: unknown }> = [];
    openInputMapStaging({
      guid,
      packPath: 'assets/IM_Test.pack.json',
      name: 'IM_Test',
      payload: createDefaultInputMapPayload(),
    });
    const host = {
      pages: {
        open: async () => key,
        close: async (pageKey: unknown, request: unknown) => {
          closed.push({ key: pageKey, request });
        },
        getSnapshot: () => ({
          generation: 0,
          activeKey: encodedKey,
          instances: [{
            key,
            encodedKey,
            typeId: '@forgeax/editor#page/input-map',
            context: {},
            resource: {
              canonicalId: guid,
              uri: `forgeax-asset://${guid}`,
              displayPath: 'IM_Test',
              kind: 'input-map',
              metadata: {
                asset: {
                  guid,
                  kind: 'input-map',
                  name: 'IM_Test',
                  payload: createDefaultInputMapPayload(),
                  packPath: 'assets/IM_Test.pack.json',
                },
              },
            },
            openedAt: 0,
            closable: true,
          }],
        }),
        subscribe: () => () => {},
      },
      resourceEditors: {
        open: async () => key,
      },
    };
    const extension = createEditorPageExtension(() => null);
    const dispose = await extension.setup?.({ host } as never);
    try {
      renameInputMapStaging(guid, 'IM_Player');
      expect(getActiveEditorAsset()?.name).toBe('IM_Player');

      broadcastAssetsChanged('pack-changed', 'local-op', { kind: 'deleted', guid });
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      expect(closed).toEqual([{
        key,
        request: { reason: 'user', decision: 'discard' },
      }]);
    } finally {
      if (typeof dispose === 'function') dispose();
      closeInputMapStaging(guid);
    }
  });

  it('attaches a PageController factory to the material-instance and input-map pages', () => {
    const extension = createEditorPageExtension(() => null);
    const mi = extension.contributes?.pages?.find((page) => page.id.endsWith('/material-instance'));
    expect(typeof mi?.createController).toBe('function');
    const inputMap = extension.contributes?.pages?.find((page) => page.id.endsWith('/input-map'));
    expect(typeof inputMap?.createController).toBe('function');
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
    for (const suffix of ['/level', '/asset', '/material-instance', '/input-map', '/vfx']) {
      const page = pages.find((candidate) => candidate.id.endsWith(suffix));
      expect(page?.layoutVersion ?? 1, suffix).toBe(1);
    }
    expect(pages.find((candidate) => candidate.id.endsWith('/mesh'))?.layoutVersion).toBe(2);
  });
});
