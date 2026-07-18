import { describe, expect, it, mock } from 'bun:test';
import { resolveFolderMenuItems } from './folder-menu';
import type { ContextMenuItem } from './CBContextMenu';

// A minimal stand-in for what buildFolderContextMenu returns — we only care that
// the resolver rewires the caller-handled ids and disables unsupported ops.
function fakeFolderMenu(builderOpen: () => void, builderFav: () => void): ContextMenuItem[] {
  return [
    { id: 'open', label: 'Open', action: builderOpen },
    { id: 'new-folder', label: 'New Folder', action: () => {} },
    { id: 'sep-1', label: '', separator: true, action: () => {} },
    { id: 'rename', label: 'Rename', action: () => {} },
    { id: 'delete', label: 'Delete', action: () => {} },
    { id: 'toggle-fav', label: 'Add to Favorites', action: builderFav },
  ];
}

describe('resolveFolderMenuItems', () => {
  it('drops separators', () => {
    const items = resolveFolderMenuItems(fakeFolderMenu(() => {}, () => {}), {
      onOpen: () => {}, onToggleFavorite: () => {},
    });
    expect(items.map(i => i.label)).toEqual(['Open', 'New Folder', 'Rename', 'Delete', 'Add to Favorites']);
  });

  it('rewires "open" to onOpen (not the builder no-op)', () => {
    const onOpen = mock(() => {});
    const builderOpen = mock(() => {});
    const items = resolveFolderMenuItems(fakeFolderMenu(builderOpen, () => {}), {
      onOpen, onToggleFavorite: () => {},
    });
    items.find(i => i.label === 'Open')!.onClick();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(builderOpen).toHaveBeenCalledTimes(0);
  });

  it('rewires "toggle-fav" to onToggleFavorite', () => {
    const onToggleFavorite = mock(() => {});
    const items = resolveFolderMenuItems(fakeFolderMenu(() => {}, () => {}), {
      onOpen: () => {}, onToggleFavorite,
    });
    items.find(i => i.label === 'Add to Favorites')!.onClick();
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
  });

  it('disables unsupported ops (rename/delete have no server API)', () => {
    const items = resolveFolderMenuItems(fakeFolderMenu(() => {}, () => {}), {
      onOpen: () => {}, onToggleFavorite: () => {}, unsupportedIds: ['rename', 'delete'],
    });
    expect(items.find(i => i.label === 'Rename')!.disabled).toBe(true);
    expect(items.find(i => i.label === 'Delete')!.disabled).toBe(true);
    expect(items.find(i => i.label === 'New Folder')!.disabled).toBeFalsy();
  });

  it('keeps non-rewired actions intact (e.g. New Folder calls its own action)', () => {
    const newFolderAction = mock(() => {});
    const menu: ContextMenuItem[] = [
      { id: 'new-folder', label: 'New Folder', action: newFolderAction },
    ];
    const items = resolveFolderMenuItems(menu, { onOpen: () => {}, onToggleFavorite: () => {} });
    items[0]!.onClick();
    expect(newFolderAction).toHaveBeenCalledTimes(1);
  });
});
