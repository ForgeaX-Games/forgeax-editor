import { describe, expect, it } from 'bun:test';
import { catalogExtensionItems, workbenchPane } from './catalog-page-extensions';

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
