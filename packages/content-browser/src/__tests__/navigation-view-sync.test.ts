// navigation-view-sync.test.ts — breadcrumb / back / tree navigation must not
// leave the asset grid showing tiles from the previous folder.

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('navigation view sync — grid resets on folder change', () => {
  const contentBrowser = readFileSync(resolve(import.meta.dir, '../ContentBrowser.tsx'), 'utf-8');
  const derivedView = readFileSync(resolve(import.meta.dir, '../hooks/useCBDerivedView.ts'), 'utf-8');
  const navHistory = readFileSync(resolve(import.meta.dir, '../hooks/useNavHistory.ts'), 'utf-8');

  it('clears expanded resource groups when nav.currentPath changes', () => {
    expect(contentBrowser).toMatch(/setExpandedPacks\(\(prev\) => \(prev\.size === 0 \? prev : new Set\(\)\)\)/);
    expect(contentBrowser).toContain('[nav.currentPath]');
  });

  it('remounts the grid/details surface keyed by the browsed path', () => {
    expect(contentBrowser).toContain('key={nav.currentPath}');
    expect(contentBrowser).toContain('<CBGrid');
    expect(contentBrowser).toContain('<CBDetailsList');
  });

  it('filters disk files with the normalized browsed path', () => {
    expect(derivedView).toContain('normalizeCBPath(nav.currentPath)');
    expect(derivedView).toContain('dirOfPath(file.path) === currentPath');
  });

  it('normalizes paths at the navigation gateway shim', () => {
    expect(navHistory).toContain('normalizeCBPath(p)');
  });
});
