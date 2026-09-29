import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveViteFsAllowRoots } from '../vite-fs-allow.ts';

describe('resolveViteFsAllowRoots', () => {
  test('includes package dir, game dir, cache root, sibling forgeax-games, and extras', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-vite-fs-allow-'));
    const packageDir = join(root, 'forgeax-editor');
    const gameDir = join(root, 'forgeax-games', 'spin-cube');
    const siblingGames = join(root, 'forgeax-games');
    const cacheRoot = join(gameDir, '.forgeax', 'vite-cache');
    const extra = join(root, 'studio-layer');
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(gameDir, { recursive: true });
    mkdirSync(cacheRoot, { recursive: true });
    mkdirSync(extra, { recursive: true });

    const allow = resolveViteFsAllowRoots({
      packageDir,
      gameDir,
      extra: [extra],
      env: { FORGEAX_VITE_CACHE_ROOT: cacheRoot },
    });

    expect(allow).toContain(resolve(packageDir));
    expect(allow).toContain(resolve(gameDir));
    expect(allow).toContain(resolve(cacheRoot));
    expect(allow).toContain(resolve(siblingGames));
    expect(allow).toContain(resolve(extra));
  });

  test('skips missing game and cache paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-vite-fs-missing-'));
    const packageDir = join(root, 'editor');
    const missingGame = join(root, 'missing-game');
    const missingCache = join(root, 'missing-cache');
    mkdirSync(packageDir, { recursive: true });

    const allow = resolveViteFsAllowRoots({
      packageDir,
      gameDir: missingGame,
      env: { FORGEAX_VITE_CACHE_ROOT: missingCache },
    });

    expect(allow).toContain(resolve(packageDir));
    expect(allow).not.toContain(resolve(missingGame));
    expect(allow).not.toContain(resolve(missingCache));
  });
});
