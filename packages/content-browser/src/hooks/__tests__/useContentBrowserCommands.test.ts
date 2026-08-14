import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, describe, expect, it } from 'bun:test';
import { createAppHost } from '@forgeax/interface/core/app-shell';
import type { CBFile, CBFolder, CBViewItem } from '../../types';
import { registerContentBrowserScopedCommands } from '../useContentBrowserCommands';

try { GlobalRegistrator.register(); } catch { /* shared DOM test environment */ }

const folder: CBFolder = {
  type: 'folder',
  path: 'assets/tree-target',
  name: 'tree-target',
  childCount: 0,
  isFavorite: false,
};
const file: CBFile = {
  type: 'file',
  path: 'assets/grid-target.txt',
  diskPath: '/game/assets/grid-target.txt',
  name: 'grid-target.txt',
  family: 'doc',
  assets: [],
  kindLabel: 'Document',
  isFavorite: false,
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  document.body.replaceChildren();
});

describe('Content Browser contextual commands', () => {
  it('routes identical keys to distinct focused widget targets', async () => {
    const { host } = createAppHost();
    const tree = document.createElement('div');
    const grid = document.createElement('div');
    document.body.append(tree, grid);
    const renamed: Array<{ item: CBViewItem; surface: 'grid' | 'tree' }> = [];
    const deleted: CBViewItem[] = [];
    let selectAllCount = 0;
    let sourceTreeItem: CBViewItem | null = null;
    let gridItem: CBViewItem | null = null;

    cleanups.push(
      host.keybindings.registerScope(tree, 'editor.contentBrowser.sourceTree'),
      host.keybindings.registerScope(grid, 'editor.contentBrowser.grid'),
      ...registerContentBrowserScopedCommands(host, {
        getSourceTreeItem: () => sourceTreeItem,
        getGridItem: () => gridItem,
        renameItem: (item, surface) => renamed.push({ item, surface }),
        deleteItem: item => deleted.push(item),
        selectAllGridItems: () => { selectAllCount += 1; },
      }),
    );
    // Focus changes are synchronous event-time facts. No React effect or
    // command re-registration is required before the following keydown.
    sourceTreeItem = folder;
    gridItem = file;

    const dispatch = (target: Element, init: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      target.addEventListener('keydown', current => host.keybindings.handle(current as KeyboardEvent), { once: true });
      target.dispatchEvent(event);
      return event;
    };

    dispatch(tree, { key: 'F2' });
    dispatch(grid, { key: 'F2' });
    dispatch(tree, { key: 'Delete' });
    dispatch(grid, { key: 'Delete' });
    dispatch(tree, { key: 'a', ctrlKey: true });
    dispatch(grid, { key: 'a', ctrlKey: true });
    await Promise.resolve();

    // F2 routes to the focused widget's item AND tags the originating surface, so
    // only that surface's inline editor mounts (a folder is visible in both).
    expect(renamed).toEqual([
      { item: folder, surface: 'tree' },
      { item: file, surface: 'grid' },
    ]);
    expect(deleted).toEqual([folder, file]);
    expect(selectAllCount).toBe(1);
  });
});
