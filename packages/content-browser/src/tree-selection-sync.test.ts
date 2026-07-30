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
//      grid-selected asset so only one CB selection is active;
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
  const tsx = readFileSync(resolve(import.meta.dir, 'CBSourceTree.tsx'), 'utf-8');

  it('imports the gateway (the one dispatch door — no human-only path)', () => {
    expect(tsx).toMatch(/import\s*\{\s*gateway\s*\}\s*from\s*'@forgeax\/editor-core'/);
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
});
