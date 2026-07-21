import { describe, expect, it } from 'bun:test';
import { resolveViewMode, isHiddenDir, isHiddenPath } from './view-mode';
import type { CatalogAssetRoot } from './catalog-root';

const ROOTS: CatalogAssetRoot[] = [
  { root: 'assets', catalogPrefix: 'games/hellforge/assets' },
  { root: '@shared/characters', catalogPrefix: 'forgeax-editor-assets/characters' },
];

describe('resolveViewMode', () => {
  it('empty path (game root) → file mode', () => {
    expect(resolveViewMode('', ROOTS)).toBe('file');
  });

  it('assets path → asset mode', () => {
    expect(resolveViewMode('assets', ROOTS)).toBe('asset');
  });

  it('assets sub-path → asset mode', () => {
    expect(resolveViewMode('assets/scenes', ROOTS)).toBe('asset');
    expect(resolveViewMode('assets/3d/characters', ROOTS)).toBe('asset');
  });

  it('src path → file mode', () => {
    expect(resolveViewMode('src', ROOTS)).toBe('file');
    expect(resolveViewMode('src/systems', ROOTS)).toBe('file');
  });

  it('other project directories → file mode', () => {
    expect(resolveViewMode('scripts', ROOTS)).toBe('file');
    expect(resolveViewMode('characters', ROOTS)).toBe('file');
    expect(resolveViewMode('workbench', ROOTS)).toBe('file');
  });

  it('external (@shared) roots are excluded from asset mode', () => {
    expect(resolveViewMode('@shared/characters', ROOTS)).toBe('file');
  });

  it('partial prefix match does not trigger asset mode', () => {
    expect(resolveViewMode('assets-backup', ROOTS)).toBe('file');
  });
});

describe('isHiddenDir', () => {
  it('hides known private directories', () => {
    expect(isHiddenDir('.forgeax')).toBe(true);
    expect(isHiddenDir('.wb-ai-asset')).toBe(true);
    expect(isHiddenDir('node_modules')).toBe(true);
    expect(isHiddenDir('.git')).toBe(true);
    expect(isHiddenDir('dist')).toBe(true);
  });

  it('does not hide regular directories', () => {
    expect(isHiddenDir('src')).toBe(false);
    expect(isHiddenDir('assets')).toBe(false);
    expect(isHiddenDir('scripts')).toBe(false);
  });
});

describe('isHiddenPath', () => {
  it('hides paths under hidden directories', () => {
    expect(isHiddenPath('.forgeax/prefs')).toBe(true);
    expect(isHiddenPath('node_modules/react')).toBe(true);
    expect(isHiddenPath('.git/objects')).toBe(true);
  });

  it('allows paths under regular directories', () => {
    expect(isHiddenPath('src/systems')).toBe(false);
    expect(isHiddenPath('assets/scenes')).toBe(false);
  });
});
