import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupSingleGameRootFarm, stageSingleGameRootFarm } from '../active-game-mount';

describe('active game mount', () => {
  test('projects a legacy parent games symlink into a child game symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-active-game-mount-'));
    try {
      const gamesRoot = join(root, 'games');
      const gameDir = join(gamesRoot, 'sample');
      const runtimeRoot = join(root, 'play-runtime');
      const farmRoot = join(runtimeRoot, 'host-games');
      mkdirSync(gameDir, { recursive: true });
      mkdirSync(runtimeRoot, { recursive: true });
      writeFileSync(join(gameDir, 'keep.txt'), 'game data');
      symlinkSync(gamesRoot, farmRoot, 'junction');

      const mount = setupSingleGameRootFarm({
        farmRoot,
        gameDir,
        gameId: 'sample',
      });

      expect(lstatSync(farmRoot).isSymbolicLink()).toBe(false);
      expect(lstatSync(mount).isSymbolicLink()).toBe(true);
      expect(realpathSync(mount)).toBe(realpathSync(gameDir));
      expect(realpathSync(join(mount, 'keep.txt'))).toBe(realpathSync(join(gameDir, 'keep.txt')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not replace a real directory at the active game mount', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-active-game-mount-'));
    try {
      const gameDir = join(root, 'games', 'sample');
      const farmRoot = join(root, 'host-games');
      mkdirSync(gameDir, { recursive: true });
      mkdirSync(join(farmRoot, 'sample'), { recursive: true });

      expect(() => setupSingleGameRootFarm({ farmRoot, gameDir, gameId: 'sample' })).toThrow(
        'refusing to replace non-symlink active game mount',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not replace a foreign farm symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-active-game-mount-'));
    try {
      const gameDir = join(root, 'games', 'sample');
      const farmRoot = join(root, 'host-games');
      mkdirSync(gameDir, { recursive: true });
      mkdirSync(join(root, 'foreign-farm'), { recursive: true });
      symlinkSync(join(root, 'foreign-farm'), farmRoot, 'junction');

      expect(() => setupSingleGameRootFarm({ farmRoot, gameDir, gameId: 'sample' })).toThrow(
        'refusing to replace foreign game mount farm symlink',
      );
      expect(lstatSync(farmRoot).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps the committed game mounted when a candidate rolls back', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-active-game-mount-'));
    try {
      const farmRoot = join(root, 'host-games');
      const gameA = join(root, 'games', 'a');
      const gameB = join(root, 'games', 'b');
      mkdirSync(gameA, { recursive: true });
      mkdirSync(gameB, { recursive: true });
      const previousMount = setupSingleGameRootFarm({ farmRoot, gameDir: gameA, gameId: 'a' });

      const candidate = stageSingleGameRootFarm({
        farmRoot,
        gameDir: gameB,
        gameId: 'b',
        previousMount,
      });
      expect(realpathSync(previousMount)).toBe(realpathSync(gameA));
      expect(realpathSync(candidate.mountPath)).toBe(realpathSync(gameB));

      candidate.rollback();
      expect(realpathSync(previousMount)).toBe(realpathSync(gameA));
      expect(existsSync(candidate.mountPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('removes the previous mount only after candidate commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-active-game-mount-'));
    try {
      const farmRoot = join(root, 'host-games');
      const gameA = join(root, 'games', 'a');
      const gameB = join(root, 'games', 'b');
      mkdirSync(gameA, { recursive: true });
      mkdirSync(gameB, { recursive: true });
      const previousMount = setupSingleGameRootFarm({ farmRoot, gameDir: gameA, gameId: 'a' });

      const candidate = stageSingleGameRootFarm({
        farmRoot,
        gameDir: gameB,
        gameId: 'b',
        previousMount,
      });
      candidate.commit();

      expect(existsSync(previousMount)).toBe(false);
      expect(realpathSync(candidate.mountPath)).toBe(realpathSync(gameB));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not roll back a committed candidate when stale mount cleanup fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-active-game-mount-'));
    try {
      const farmRoot = join(root, 'host-games');
      const gameDir = join(root, 'games', 'b');
      const foreignPrevious = join(farmRoot, 'foreign-directory');
      mkdirSync(gameDir, { recursive: true });
      mkdirSync(foreignPrevious, { recursive: true });
      const candidate = stageSingleGameRootFarm({
        farmRoot,
        gameDir,
        gameId: 'b',
        previousMount: foreignPrevious,
      });

      expect(() => candidate.commit()).not.toThrow();
      expect(realpathSync(candidate.mountPath)).toBe(realpathSync(gameDir));
      expect(lstatSync(foreignPrevious).isDirectory()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
