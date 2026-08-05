import { describe, expect, it, afterEach } from 'bun:test';
import {
  isUnderAssetsDir,
  resolveMaterialCreateGameRelDir,
  clampMaterialPackPath,
} from '../util/material-pack-path';
import { setPathResolver } from '../util/path-resolver';

describe('isUnderAssetsDir', () => {
  it('accepts assets root and subdirs (game-relative)', () => {
    expect(isUnderAssetsDir('assets')).toBe(true);
    expect(isUnderAssetsDir('assets/')).toBe(true);
    expect(isUnderAssetsDir('assets/ui')).toBe(true);
    expect(isUnderAssetsDir('assets/materials/foo')).toBe(true);
  });

  it('accepts host-resolved paths containing an assets segment', () => {
    expect(isUnderAssetsDir('/games/demo/assets/Materials.pack.json')).toBe(true);
    expect(isUnderAssetsDir('27-game/assets/ui/Materials.pack.json')).toBe(true);
  });

  it('rejects paths outside assets (segment-aware)', () => {
    expect(isUnderAssetsDir('')).toBe(false);
    expect(isUnderAssetsDir('src')).toBe(false);
    expect(isUnderAssetsDir('sessions/x/logs')).toBe(false);
    expect(isUnderAssetsDir('myassets/foo')).toBe(false);
    expect(isUnderAssetsDir('assets-backup')).toBe(false);
    expect(isUnderAssetsDir('/games/demo/src/Materials.pack.json')).toBe(false);
  });
});

describe('resolveMaterialCreateGameRelDir', () => {
  it('keeps assets subdirs', () => {
    expect(resolveMaterialCreateGameRelDir('assets/ui')).toEqual({
      dir: 'assets/ui',
      redirected: false,
    });
  });

  it('redirects non-assets paths to assets root', () => {
    expect(resolveMaterialCreateGameRelDir('src')).toEqual({ dir: 'assets', redirected: true });
    expect(resolveMaterialCreateGameRelDir('')).toEqual({ dir: 'assets', redirected: true });
    expect(resolveMaterialCreateGameRelDir('sessions/logs')).toEqual({
      dir: 'assets',
      redirected: true,
    });
  });
});

describe('clampMaterialPackPath', () => {
  afterEach(() => setPathResolver(null));

  it('keeps pack paths already under assets/', () => {
    expect(clampMaterialPackPath('demo/assets/ui/Materials.pack.json')).toEqual({
      packPath: 'demo/assets/ui/Materials.pack.json',
      redirected: false,
    });
  });

  it('redirects outside assets/ using the path resolver when installed', () => {
    setPathResolver((rel) => (rel ? `/games/demo/${rel}` : '/games/demo'));
    expect(clampMaterialPackPath('/games/demo/sessions/logs/Materials.pack.json')).toEqual({
      packPath: '/games/demo/assets/Materials.pack.json',
      redirected: true,
    });
  });

  it('falls back to assets/Materials.pack.json without a resolver', () => {
    expect(clampMaterialPackPath('src/foo/Materials.pack.json')).toEqual({
      packPath: 'assets/Materials.pack.json',
      redirected: true,
    });
  });
});
