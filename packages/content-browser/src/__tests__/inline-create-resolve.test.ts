import { describe, expect, it } from 'bun:test';
import { resolveInlineFolderCreateItem } from '../inline-create-resolve';
import type { CBFolder } from '../types';

describe('resolveInlineFolderCreateItem', () => {
  const folder: CBFolder = {
    type: 'folder',
    path: 'assets/Foo',
    name: 'Foo',
    isFavorite: false,
    childCount: 0,
  };

  it('finds a folder by path', () => {
    expect(resolveInlineFolderCreateItem('assets/Foo', [folder])).toBe(folder);
  });

  it('returns undefined when the folder is not in the current view', () => {
    expect(resolveInlineFolderCreateItem('assets/Missing', [folder])).toBeUndefined();
  });
});
