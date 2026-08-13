import { describe, expect, it } from 'bun:test';
import type { ExtensionInfo } from '../../lib/extension-api';
import {
  catalogExtensionItems,
  catalogPanelTypeRegistrations,
  workbenchPane,
} from './catalog-page-extensions';

describe('catalogExtensionItems', () => {
  it('fails closed when a runtime response omits items', () => {
    expect(catalogExtensionItems({})).toEqual([]);
    expect(catalogExtensionItems(undefined)).toEqual([]);
  });

  it('preserves a validated extension list', () => {
    const items = [{ id: 'example' }];
    expect(catalogExtensionItems({ items })).toBe(items);
  });
});

describe('workbenchPane', () => {
  it('only accepts runtime pane values carried by a Page placement', () => {
    expect(workbenchPane({ pane: 'left' })).toBe('left');
    expect(workbenchPane({ pane: 'center' })).toBe('center');
    expect(workbenchPane({ pane: 'right' })).toBeUndefined();
    expect(workbenchPane()).toBeUndefined();
  });
});

describe('catalogPanelTypeRegistrations', () => {
  const base: ExtensionInfo = {
    id: '@demo/tool',
    version: '1.0.0',
    kind: 'workbench',
    displayName: 'Demo Tool',
    contributes: {
      panelTypes: [{ id: 'main', runtime: 'inline' }],
    },
  };

  it('maps standalone extensions to a complete plugin window target', () => {
    const [panel] = catalogPanelTypeRegistrations({
      ...base,
      entry: { standalone: {} },
    });
    const createTarget = panel!.windowing!.createTarget;
    const target = createTarget({
      pageKey: {
        cardinality: 'singleton',
        typeId: '@demo/tool#page/main',
      },
      placementId: 'content',
      pageContext: {},
      initialProps: { pane: 'left' },
    } as Parameters<typeof createTarget>[0]);

    expect(target).toEqual({
      surface: {
        kind: 'plugin',
        id: '@demo/tool',
        pane: 'left',
        instance: 'page:v1:s:%40demo%2Ftool%23page%2Fmain::content',
      },
      title: 'Demo Tool',
      width: 960,
      height: 720,
      dockBehavior: 'keep-anchor',
    });
  });

  it('does not declare windowing for embedded-only extensions', () => {
    const [panel] = catalogPanelTypeRegistrations(base);
    expect(panel?.windowing).toBeUndefined();
  });

  it('keeps Workbench host extensions dock-only without a detached renderer', () => {
    const [panel] = catalogPanelTypeRegistrations({
      ...base,
      id: '@forgeax-extension/wb-game-video',
      entry: { standalone: {} },
    });
    expect(panel?.windowing).toBeUndefined();
  });
});
