import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createAppHost, HostProvider } from '@forgeax/interface/core/app-shell';
import { CBSourceTree } from '../CBSourceTree';
import type { SourceTreeNode } from '../content-browser-format';

try { GlobalRegistrator.register(); } catch { /* another content-browser DOM test already registered it */ }
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function folder(path: string, children: SourceTreeNode[] = []): SourceTreeNode {
  return {
    type: 'folder',
    path,
    diskPath: `/projects/demo/${path}`,
    name: path.split('/').pop() ?? path,
    childCount: children.length,
    isFavorite: false,
    children,
  };
}

function file(path: string): SourceTreeNode {
  return {
    type: 'file',
    path,
    diskPath: `/projects/demo/${path}`,
    name: path.split('/').pop() ?? path,
    childCount: 0,
    isFavorite: false,
    family: 'doc',
    children: [],
  };
}

function favoriteFolder(path: string): SourceTreeNode {
  return { ...folder(path), isFavorite: true };
}

const sourceTree: SourceTreeNode[] = [
  folder('assets', [folder('assets/hello'), file('assets/readme.md')]),
  favoriteFolder('empty'),
];

const navigated: string[] = [];

function Harness({ children }: { children?: ReactNode }) {
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const [favoritesOnly, setFavoritesOnly] = React.useState(false);
  const [host] = React.useState(() => createAppHost().host);
  return (
    <HostProvider value={host}>
      <CBSourceTree
        projectName="Demo"
        favoritesOnly={favoritesOnly}
        setFavoritesOnly={setFavoritesOnly}
        sourceTree={sourceTree}
        collapsedSourceFolders={collapsed}
        setCollapsedSourceFolders={setCollapsed}
        selectedPath={null}
        setSelectedItem={() => {}}
        setPreviewItem={() => {}}
        onFocusItem={() => {}}
        nav={{ currentPath: '', navigate: (path) => { navigated.push(path); } }}
        openFolderContextMenu={() => {}}
        openFileContextMenu={() => {}}
      />
    </HostProvider>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  navigated.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Content Browser source tree interaction', () => {
  it('renders two independent accordion groups (Favorites + Project)', () => {
    const heads = container.querySelectorAll('.cb-source-group-head');
    expect(heads.length).toBe(2);
  });

  it('expands project folders by default, collapses on double-click, and keeps leaf folders non-expandable', () => {
    const assets = container.querySelector<HTMLButtonElement>('.cb-source-row[title="assets"]');
    expect(assets).not.toBeNull();
    // Nested children are visible without any interaction (default-expanded).
    expect(container.querySelector<HTMLButtonElement>('.cb-source-row[title="assets/hello"]')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('.cb-source-row[title="assets/readme.md"]')).not.toBeNull();
    // Leaf folders carry no disclosure chevron.
    expect(container.querySelector<HTMLButtonElement>('.cb-source-row[title="assets/hello"] .cb-source-chev')?.className).toContain('hidden');

    // A double-click collapses the folder, hiding its children.
    act(() => assets!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(container.querySelector<HTMLButtonElement>('.cb-source-row[title="assets/readme.md"]')).toBeNull();
  });

  it('flat-lists favorited directories under the Favorites group and navigates on click', () => {
    const favBody = container.querySelector('.cb-source-group .cb-source-group-body');
    const favRow = favBody?.querySelector<HTMLButtonElement>('.cb-source-row[title="empty"]');
    expect(favRow).not.toBeNull();

    act(() => favRow!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(navigated).toContain('empty');
  });

  it('collapses a group body when its head is clicked', () => {
    const projectHead = Array.from(container.querySelectorAll<HTMLButtonElement>('.cb-source-group-head'))
      .find(head => head.title === 'Demo');
    expect(projectHead).not.toBeNull();
    expect(container.querySelector('.cb-source-row[title="assets"]')).not.toBeNull();

    act(() => projectHead!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.querySelector('.cb-source-row[title="assets"]')).toBeNull();
  });
});
