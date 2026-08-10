import { dirname, resolve } from 'node:path';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';

export type ActiveGameMountRequest = {
  farmRoot: string;
  gameDir: string;
  gameId: string;
  previousMount?: string;
};

function ensureFarmDirectory(mountRoot: string, targetPath: string): void {
  let existing;
  try {
    existing = lstatSync(mountRoot);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      mkdirSync(mountRoot, { recursive: true });
      return;
    }
    throw error;
  }

  if (existing.isDirectory()) return;
  if (!existing.isSymbolicLink()) {
    throw new Error(`refusing to replace non-directory game mount farm: ${mountRoot}`);
  }

  // Older standalone stacks mounted the whole parent games directory at
  // `host-games`. Migrate only that exact generated shape: unlinking the
  // symlink preserves the real games directory and lets the new contract
  // create one child symlink per active game.
  let pointsToGameParent = false;
  try {
    pointsToGameParent = realpathSync(mountRoot) === dirname(realpathSync(targetPath));
  } catch {
    // A foreign or broken symlink is not safe to replace automatically.
  }
  if (!pointsToGameParent) {
    throw new Error(`refusing to replace foreign game mount farm symlink: ${mountRoot}`);
  }
  unlinkSync(mountRoot);
  mkdirSync(mountRoot, { recursive: true });
}

/**
 * Mount exactly one physical game directory below the Play Runtime Vite root.
 * The returned path is the generated child symlink and can be retained by the
 * runtime-scope controller as its previous mount on the next rebind.
 */
export function setupSingleGameRootFarm({
  farmRoot,
  gameDir,
  gameId,
  previousMount,
}: ActiveGameMountRequest): string {
  const targetPath = resolve(gameDir);
  const mountRoot = resolve(farmRoot);
  if (!existsSync(targetPath)) {
    throw new Error(`active game directory does not exist: ${targetPath}`);
  }
  ensureFarmDirectory(mountRoot, targetPath);
  const linkPath = resolve(mountRoot, gameId);
  if (previousMount !== undefined && previousMount !== linkPath) {
    try {
      if (lstatSync(previousMount).isSymbolicLink()) unlinkSync(previousMount);
    } catch { /* the previous exact mount may already be gone */ }
  }
  try {
    const existing = lstatSync(linkPath);
    if (!existing.isSymbolicLink()) {
      throw new Error(`refusing to replace non-symlink active game mount: ${linkPath}`);
    }
    if (realpathSync(linkPath) === realpathSync(targetPath)) {
      return linkPath;
    }
    unlinkSync(linkPath);
  } catch (error) {
    if (error instanceof Error && !error.message.includes('ENOENT')) throw error;
  }
  // Remove a broken generated junction before recreating the exact active-game mount.
  try {
    const stale = lstatSync(linkPath);
    if (stale.isSymbolicLink()) unlinkSync(linkPath);
  } catch {
    // No existing mount.
  }
  symlinkSync(targetPath, linkPath, 'junction');
  return linkPath;
}
