import { describe, expect, it } from 'bun:test';
import { catalogExtensionItems, catalogPageLayout } from './catalog-page-extensions';

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

describe('catalog Page layout adapter', () => {
  it('wraps one or more placements in Dockview required branch root', () => {
    const layout = catalogPageLayout('main', 'Example Page', [{ id: 'primary' }, { id: 'details' }]);
    expect('grid' in layout).toBe(true);
    if (!('grid' in layout)) throw new Error('expected serialized Dockview layout');

    expect(layout.grid.root).toMatchObject({
      type: 'branch',
      data: [{
        type: 'leaf',
        data: { views: ['primary', 'details'], activeView: 'primary', id: 'page-main' },
      }],
    });
    expect(Object.keys(layout.panels)).toEqual(['primary', 'details']);
  });

  it('uses the user-facing Page title for a single catalog placement', () => {
    const layout = catalogPageLayout('main', 'Scene Generator', [{ id: 'content' }]);
    expect('grid' in layout).toBe(true);
    if (!('grid' in layout)) throw new Error('expected serialized Dockview layout');

    expect(layout.panels.content?.title).toBe('Scene Generator');
  });
});
