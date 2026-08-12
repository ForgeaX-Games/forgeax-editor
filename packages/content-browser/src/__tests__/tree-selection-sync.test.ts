// tree-selection-sync.test.ts — regression gate for "left tree selection does
// not sync to the right grid" (2026-07-30).
//
// Root cause: CBSourceTree clicks wrote only the local `previewItem` React
// state and NEVER dispatched `setFolderSelection` — a human-only path that
// bypassed the one gateway door (north-star violation). The right grid reads
// selection from the folder-selection store (via useMultiSelect →
// useFolderSelectionSet), so tree selections never lit the grid card.
//
// Fix: tree clicks dispatch BOTH selection ops, mirroring the grid's
// useMultiSelect.dispatchSet dual-dispatch:
//   1. setAssetSelection { assets: [], primary: null }  — FIRST: clears any
//      grid-selected asset so the path-domain subject is active;
//   2. setFolderSelection { items: [{ path, kind }] }   — LAST: the non-empty
//      forward select derives lastSelectionDomain = 'folder' (empty dispatches
//      are dedup-guarded and never advance the domain).
//
// Two layers:
//   - behavioral: the gateway → folder-selection store chain the grid reads;
//   - contract: the tree's click wiring cannot silently drop the dispatch again.

import { afterAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  gateway,
  getFolderSelectionList,
  getPathSelectionList,
  getLastSelectionDomain,
} from '@forgeax/editor-core';

afterAll(() => {
  // Restore module-level selection state so later test files see a clean store.
  gateway.dispatch({ kind: 'setFolderSelection', items: [] });
});

describe('tree selection sync — gateway → folder-selection store (grid read model)', () => {
  it('dispatching setFolderSelection updates the path selection the grid highlights from', () => {
    gateway.dispatch({
      kind: 'setFolderSelection',
      items: [{ path: 'assets/scenes', kind: 'dir' }],
    });
    expect(getFolderSelectionList()).toEqual(['assets/scenes']);
    expect(getPathSelectionList()).toEqual([{ path: 'assets/scenes', kind: 'dir' }]);
  });

  it('a forward (non-empty) path selection advances lastSelectionDomain to folder', () => {
    expect(getLastSelectionDomain()).toBe('folder');
  });

  it('an empty asset-selection dispatch does NOT hijack the domain (order-invariant guard)', () => {
    // This is why selectTreePath can safely empty the asset domain FIRST:
    // empty dispatches are dedup/domain-guarded, the folder dispatch lands LAST.
    gateway.dispatch({ kind: 'setAssetSelection', assets: [], primary: null });
    expect(getLastSelectionDomain()).toBe('folder');
    expect(getFolderSelectionList()).toEqual(['assets/scenes']);
  });

  it('a same-items dispatch is deduped (no state churn)', () => {
    gateway.dispatch({
      kind: 'setFolderSelection',
      items: [{ path: 'assets/scenes', kind: 'dir' }],
    });
    expect(getFolderSelectionList()).toEqual(['assets/scenes']);
  });
});

describe('tree selection sync — CBSourceTree click wiring contract', () => {
  const tsx = readFileSync(resolve(import.meta.dir, '../CBSourceTree.tsx'), 'utf-8');
  const contentBrowser = readFileSync(resolve(import.meta.dir, '../ContentBrowser.tsx'), 'utf-8');
  const css = readFileSync(resolve(import.meta.dir, '../content-browser.css'), 'utf-8');

  it('imports the active Runtime dispatcher (the one dispatch door — no shell fallback)', () => {
    expect(tsx).toMatch(/import\s*\{[^}]*dispatchActiveEditorOperation[^}]*\}\s*from\s*'@forgeax\/editor-core'/);
  });

  it('selectTreePath empties the asset domain FIRST, sets the path selection LAST', () => {
    const fnStart = tsx.indexOf('function selectTreePath');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = tsx.slice(fnStart, tsx.indexOf('\n}', fnStart));
    const assetIdx = fnBody.indexOf("kind: 'setAssetSelection'");
    const folderIdx = fnBody.indexOf("kind: 'setFolderSelection'");
    expect(assetIdx).toBeGreaterThan(-1);
    expect(folderIdx).toBeGreaterThan(-1);
    // Order is load-bearing: the folder dispatch must land LAST so
    // lastSelectionDomain derives to 'folder'.
    expect(assetIdx).toBeLessThan(folderIdx);
    expect(fnBody).toContain('assets: []');
  });

  it('tree clicks dispatch for BOTH branches (file + folder)', () => {
    expect(tsx).toContain("selectTreePath(file.path, 'file')");
    expect(tsx).toContain("selectTreePath(folder.path, 'dir')");
  });

  it('keeps the exact subject selection separate from its ancestor path chain', () => {
    expect(tsx).toContain('selectedPath: string | null');
    expect(tsx).toContain('isPathInSelectionChain(selectedPath, node.path)');
    expect(tsx).toContain("' is-path'");
    expect(tsx).toContain("' is-sel'");
    expect(contentBrowser).toContain('selectedPath={selectedSourcePath}');
    expect(css).toContain('.cb-source-row.is-path:not(.is-sel)');
  });

  it('single-click selects without changing disclosure, while double-click owns folder toggle', () => {
    const clickStart = tsx.indexOf('const handleClick = () => {');
    const doubleClickStart = tsx.indexOf('const handleDoubleClick = () => {');
    expect(clickStart).toBeGreaterThan(-1);
    expect(doubleClickStart).toBeGreaterThan(clickStart);

    const clickBody = tsx.slice(clickStart, doubleClickStart);
    expect(clickBody).not.toContain('setCollapsedSourceFolders');
    expect(tsx).toContain('onDoubleClick={handleDoubleClick}');
    expect(tsx).toContain('if (!expandable) return;');
    expect(tsx).toContain('[node.path]: prev[node.path] !== true');
  });

  it('expands folders by default; the store records only double-click collapses', () => {
    expect(tsx).toContain('const open = expandable && collapsedSourceFolders[node.path] !== true;');
    expect(tsx).toContain('style={{ paddingLeft: `${16 + depth * 14}px` }}');
  });

  it('does not expose disclosure UI or toggling for leaf folders', () => {
    expect(tsx).toContain("const expandable = node.type === 'folder' && node.children.length > 0;");
    expect(tsx).toContain('if (!expandable) return;');
    expect(tsx).toContain("${expandable ? '' : ' hidden'}");
    expect(tsx).toContain("expandable && open ? 'folder-open' : 'folder'");
  });

  it('renders two independent accordion groups (favorites + project) without counts', () => {
    // Favorites + Project are separate accordions that can be open at once —
    // each head toggles only its own body.
    expect(tsx).toContain('cb-source-group-head');
    expect(tsx).toContain('cb-source-group-body');
    expect(tsx).toContain('renderRows(sourceTree, 0');
    expect(tsx).toContain('collectFavoriteDirs(sourceTree)');
    expect(tsx).toContain('const [favoritesGroupOpen, setFavoritesGroupOpen] = useState(true);');
    expect(tsx).toContain('const [projectOpen, setProjectOpen] = useState(true);');
    expect(tsx).toContain('editor.contentBrowser.sourceTree.favorites');
    expect(tsx).not.toContain('cb-source-count');
    expect(tsx).not.toContain('assetCount');
  });

  it('keeps folder cards borderless until hover', () => {
    expect(css).toContain('.cb-grid-folder { border-color: transparent; }');
    expect(css).toContain('.cb-grid-folder:hover { border-color: var(--color-border-subtle');
  });

  it('gives top-level navigation rows a stronger visual hierarchy', () => {
    expect(css).toContain('.cb-source-zone-head.collapsed .cb-source-chev');
    expect(css).toContain('font-size: 13.5px;');
    expect(css).toContain('background: var(--color-background-elevated');
    expect(css).toContain('.cb-source-row.cb-source-favorites-row');
  });
});
