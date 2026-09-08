import { describe, expect, it } from 'bun:test';
import {
  CATALOG_ROOT_REQUIRED_KINDS,
  isUnderCatalogRoot,
  kindRequiresCatalogRoot,
  resolveCatalogAuthoringDir,
} from '../util/catalog-authoring-path';

describe('isUnderCatalogRoot', () => {
  it('accepts assets root and subdirs', () => {
    expect(isUnderCatalogRoot('assets', ['assets'])).toBe(true);
    expect(isUnderCatalogRoot('assets/ui', ['assets'])).toBe(true);
    expect(isUnderCatalogRoot('assets/materials/foo', ['assets'])).toBe(true);
  });

  it('accepts custom declared local roots', () => {
    expect(isUnderCatalogRoot('content/ui', ['content', 'assets'])).toBe(true);
    expect(isUnderCatalogRoot('assets/ui', ['content'])).toBe(false);
  });

  it('rejects paths outside declared roots', () => {
    expect(isUnderCatalogRoot('', ['assets'])).toBe(false);
    expect(isUnderCatalogRoot('src', ['assets'])).toBe(false);
    expect(isUnderCatalogRoot('test-material', ['assets'])).toBe(false);
    expect(isUnderCatalogRoot('myassets/foo', ['assets'])).toBe(false);
  });

  it('ignores external @shared roots for local authoring checks', () => {
    expect(isUnderCatalogRoot('src', ['@shared/foo'])).toBe(false);
    expect(isUnderCatalogRoot('assets/ui', ['@shared/foo', 'assets'])).toBe(true);
  });
});

describe('resolveCatalogAuthoringDir', () => {
  it('returns dir under assets', () => {
    expect(resolveCatalogAuthoringDir('assets/ui')).toEqual({ ok: true, dir: 'assets/ui' });
    expect(resolveCatalogAuthoringDir('assets')).toEqual({ ok: true, dir: 'assets' });
  });

  it('fails outside catalog roots', () => {
    expect(resolveCatalogAuthoringDir('src')).toEqual({ ok: false });
    expect(resolveCatalogAuthoringDir('')).toEqual({ ok: false });
    expect(resolveCatalogAuthoringDir('test-material')).toEqual({ ok: false });
  });
});

describe('kindRequiresCatalogRoot', () => {
  it('matches material and particle-effect only', () => {
    expect(CATALOG_ROOT_REQUIRED_KINDS).toEqual(['material', 'particle-effect']);
    expect(kindRequiresCatalogRoot('material')).toBe(true);
    expect(kindRequiresCatalogRoot('particle-effect')).toBe(true);
    expect(kindRequiresCatalogRoot('scene')).toBe(false);
    expect(kindRequiresCatalogRoot('input-map')).toBe(false);
  });
});
