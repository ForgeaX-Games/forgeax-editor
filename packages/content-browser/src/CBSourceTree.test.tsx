import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createAppHost, HostProvider } from '@forgeax/interface/core/app-shell';
import { CBSourceTree } from './CBSourceTree';
import type { SourceTreeNode } from './content-browser-format';

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

const sourceTree: SourceTreeNode[] = [
  folder('assets', [folder('assets/hello'), file('assets/readme.md')]),
  folder('empty'),
];

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
        nav={{ currentPath: '', navigate: () => {} }}
        openFolderContextMenu={() => {}}
        openFileContextMenu={() => {}}
      />
    </HostProvider>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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
  it('starts closed, opens project children on double-click, and keeps leaf folders non-expandable', () => {
    const project = container.querySelector<HTMLButtonElement>('.cb-source-zone-head');
    expect(project).not.toBeNull();
    expect(container.querySelector('.cb-source-project-children')).toBeNull();

    act(() => project!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(container.querySelector('.cb-source-project-children')).not.toBeNull();
    const assets = container.querySelector<HTMLButtonElement>('.cb-source-row[title="assets"]');
    expect(assets).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('.cb-source-row[title="assets/hello"]')).toBeNull();

    act(() => assets!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(container.querySelector<HTMLButtonElement>('.cb-source-row[title="assets/readme.md"]')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('.cb-source-row[title="assets/hello"] .cb-source-chev')?.className).toContain('hidden');
  });
});
