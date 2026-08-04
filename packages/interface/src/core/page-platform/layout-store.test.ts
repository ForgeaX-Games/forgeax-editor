import { beforeEach, describe, expect, it } from 'bun:test';
import type { QualifiedPageTypeId } from '@forgeax/types';
import { pageLayoutStore } from './layout-store';

const pageTypeId = '@forgeax/test#page/main' as QualifiedPageTypeId;
const identity = { pageTypeId, layoutVersion: 3 };
const layout = {
  grid: { height: 100, width: 100, orientation: 'HORIZONTAL' as const },
  panels: {},
};

describe('PageLayoutStore', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips a versioned page layout envelope', () => {
    pageLayoutStore.save('layout', identity, layout);
    expect(pageLayoutStore.load('layout', identity)).toEqual(layout);
  });

  it('drops only the mismatched layout family', () => {
    pageLayoutStore.save('layout', identity, layout);
    localStorage.setItem('other', 'preserved');

    expect(pageLayoutStore.load('layout', { ...identity, layoutVersion: 4 })).toBeNull();
    expect(localStorage.getItem('layout')).toBeNull();
    expect(localStorage.getItem('other')).toBe('preserved');
  });

  it('rejects malformed and legacy bare layouts', () => {
    localStorage.setItem('layout', JSON.stringify(layout));
    expect(pageLayoutStore.load('layout', identity)).toBeNull();
    expect(localStorage.getItem('layout')).toBeNull();
  });
});
