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

import { resolveGameAssetRoots, readDeclaredRoots, SHARED_ROOT_PREFIX } from '../asset-roots';

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
