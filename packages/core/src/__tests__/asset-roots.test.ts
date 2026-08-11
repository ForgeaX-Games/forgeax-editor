/// <reference types="bun" />

// Unit gate for the `@shared/<sub>` external-asset-root alias resolver.
//
// resolveGameAssetRoots is the ONE editor-layer seam that turns a game's
// declared `forgeax.assets.roots` (local dirs + `@shared/<sub>` external roots)
// into resolved absolute paths, BEFORE they reach the engine's loadAssetConfig
// (which would blindly join(cwd, '@shared/x') and mangle it). Both vite configs
// (play-runtime + edit-runtime) depend on this classification being correct:
//   - `shared` flag → play-runtime routes the root through its symlink farm.
//   - existsSync filter → an absent scope silently drops (matches the runtimes'
//     prior .filter(existsSync) behavior).
//   - implicitSharedSubs → edit-runtime injects template-game-default for every
//     game without editing the engine submodule's template package.json.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { resolveGameAssetRoots, resolveGameCatalogRoots, readDeclaredRoots, SHARED_ROOT_PREFIX, expandPackRootsExcludingShaderSources } from '../asset-roots';

let tmpRoot: string;
let gameDir: string;
let sharedBase: string;

function writeRoots(roots: string[]): void {
  writeFileSync(join(gameDir, 'package.json'), JSON.stringify({ forgeax: { assets: { roots } } }));
}

beforeAll(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), 'fx-asset-roots-'));
  gameDir = join(tmpRoot, 'games', 'sample');
  mkdirSync(join(gameDir, 'assets'), { recursive: true });
  sharedBase = join(tmpRoot, 'forgeax-editor-assets');
  mkdirSync(join(sharedBase, 'characters'), { recursive: true });
  mkdirSync(join(sharedBase, 'template-game-default'), { recursive: true });
});

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolveGameAssetRoots — @shared alias classification', () => {
  it('exposes the alias prefix as a constant', () => {
    expect(SHARED_ROOT_PREFIX).toBe('@shared/');
  });

  it('readDeclaredRoots returns raw strings and falls back to ["assets"]', () => {
    writeRoots(['assets', '@shared/characters']);
    expect(readDeclaredRoots(gameDir)).toEqual(['assets', '@shared/characters']);
    // Missing package.json anywhere else → default.
    expect(readDeclaredRoots(join(tmpRoot, 'nonexistent'))).toEqual(['assets']);
  });

  it('classifies local vs @shared roots with correct abs paths', () => {
    writeRoots(['assets', '@shared/characters']);
    const roots = resolveGameAssetRoots(gameDir, { sharedBase });
    const local = roots.find((r) => !r.shared);
    const shared = roots.find((r) => r.shared);

    expect(local?.abs).toBe(resolve(gameDir, 'assets'));
    expect(local?.sub).toBeUndefined();

    expect(shared?.sub).toBe('characters');
    expect(shared?.abs).toBe(resolve(sharedBase, 'characters'));
  });

  it('projects the same package declarations into the catalog root contract', () => {
    writeRoots(['assets', '@shared/characters']);
    expect(resolveGameCatalogRoots(gameDir, {
      sharedBase,
      catalogPrefixFor: (root) => `farm/${root.shared ? root.sub : 'game-assets'}`,
    })).toEqual([
      { root: 'assets', catalogPrefix: 'farm/game-assets' },
      { root: '@shared/characters', catalogPrefix: 'farm/characters' },
    ]);
  });

  it('drops a @shared/<sub> whose dir does not exist (existsSync filter)', () => {
    writeRoots(['assets', '@shared/absent']);
    const roots = resolveGameAssetRoots(gameDir, { sharedBase });
    expect(roots.some((r) => r.sub === 'absent')).toBe(false);
    expect(roots.some((r) => !r.shared)).toBe(true); // local assets still present
  });

  it('injects implicitSharedSubs the game did not declare, de-duped', () => {
    writeRoots(['assets']);
    const roots = resolveGameAssetRoots(gameDir, {
      sharedBase,
      implicitSharedSubs: ['template-game-default'],
    });
    expect(roots.some((r) => r.sub === 'template-game-default')).toBe(true);

    // Declaring it explicitly AND injecting it must not double it.
    writeRoots(['assets', '@shared/template-game-default']);
    const roots2 = resolveGameAssetRoots(gameDir, {
      sharedBase,
      implicitSharedSubs: ['template-game-default'],
    });
    expect(roots2.filter((r) => r.sub === 'template-game-default').length).toBe(1);
  });
});

describe('expandPackRootsExcludingShaderSources — build-only shader boundary', () => {
  // The engine catalog fails closed (whole catalog empties) when a scanned
  // root contains `importer: 'shader'` sidecars; the canonical template ships
  // them under assets/shaders next to runtime packs. These gates pin the
  // editor-layer boundary that keeps such games loadable.

  function makeGameAssets(): string {
    const assets = join(gameDir, 'assets');
    mkdirSync(assets, { recursive: true });
    return assets;
  }

  it('keeps a clean directory root in directory form (live discovery preserved)', () => {
    const assets = makeGameAssets();
    writeFileSync(join(assets, 'scene.pack.json'), '{}');
    const expansion = expandPackRootsExcludingShaderSources([assets]);
    expect(expansion.excludedShaderSidecars).toEqual([]);
    expect(expansion.roots).toEqual([assets]);
  });

  it('expands a shader-tainted root to explicit file roots, excluding shader sidecars', () => {
    const assets = makeGameAssets();
    writeFileSync(join(assets, 'scene.pack.json'), '{}');
    writeFileSync(
      join(assets, 'target-profile.json.meta.json'),
      JSON.stringify({ importer: 'target-profile', subAssets: [] }),
    );
    mkdirSync(join(assets, 'shaders'), { recursive: true });
    writeFileSync(
      join(assets, 'shaders', 'hit-flash.wgsl.meta.json'),
      JSON.stringify({ importer: 'shader', subAssets: [] }),
    );

    const expansion = expandPackRootsExcludingShaderSources([assets]);
    expect(expansion.excludedShaderSidecars).toEqual([join(assets, 'shaders', 'hit-flash.wgsl.meta.json')]);
    expect(expansion.roots).not.toContain(assets);
    expect(expansion.roots).toContain(join(assets, 'scene.pack.json'));
    expect(expansion.roots).toContain(join(assets, 'target-profile.json.meta.json'));
    expect(expansion.roots.some((r) => r.includes('hit-flash'))).toBe(false);
  });

  it('collects pack files from nested dirs and skips blacklisted dirs', () => {
    const assets = makeGameAssets();
    mkdirSync(join(assets, 'ui'), { recursive: true });
    writeFileSync(join(assets, 'ui', 'hud.pack.json'), '{}');
    mkdirSync(join(assets, 'node_modules'), { recursive: true });
    writeFileSync(join(assets, 'node_modules', 'stray.pack.json'), '{}');
    mkdirSync(join(assets, 'shaders'), { recursive: true });
    writeFileSync(
      join(assets, 'shaders', 'x.wgsl.meta.json'),
      JSON.stringify({ importer: 'shader', subAssets: [] }),
    );

    const expansion = expandPackRootsExcludingShaderSources([assets]);
    expect(expansion.roots).toContain(join(assets, 'ui', 'hud.pack.json'));
    expect(expansion.roots.some((r) => r.includes('node_modules'))).toBe(false);
  });
});
