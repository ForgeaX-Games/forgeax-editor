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

export type ActiveGameMountTransition = {
  readonly mountPath: string;
  commit(): void;
  rollback(): void;
};

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function removeGeneratedMount(path: string): void {
  try {
    const entry = lstatSync(path);
    if (!entry.isSymbolicLink()) {
      throw new Error(`refusing to remove non-symlink active game mount: ${path}`);
    }
    unlinkSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function ensureFarmDirectory(mountRoot: string, targetPath: string): void {
  let existing;
  try {
    existing = lstatSync(mountRoot);
  } catch (error) {
    if (isMissing(error)) {
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
 * Stage the candidate game beside the currently committed mount. The old mount
 * remains readable while Pack attempts its transactional rebind. Only commit
 * removes it; rollback removes the candidate and restores any replaced stale
 * candidate link.
 */
export function stageSingleGameRootFarm({
  farmRoot,
  gameDir,
  gameId,
  previousMount,
}: ActiveGameMountRequest): ActiveGameMountTransition {
  const targetPath = resolve(gameDir);
  const mountRoot = resolve(farmRoot);
  if (!existsSync(targetPath)) {
    throw new Error(`active game directory does not exist: ${targetPath}`);
  }
  ensureFarmDirectory(mountRoot, targetPath);
  const linkPath = resolve(mountRoot, gameId);
  let replacedTarget: string | undefined;
  let createdCandidate = false;
  try {
    const existing = lstatSync(linkPath);
    if (!existing.isSymbolicLink()) {
      throw new Error(`refusing to replace non-symlink active game mount: ${linkPath}`);
    }
    if (realpathSync(linkPath) === realpathSync(targetPath)) {
      return createTransition(linkPath, previousMount, false, undefined);
    }
    replacedTarget = realpathSync(linkPath);
    unlinkSync(linkPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  // Remove a broken generated junction before recreating the exact active-game mount.
  try {
    const stale = lstatSync(linkPath);
    if (stale.isSymbolicLink()) unlinkSync(linkPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  symlinkSync(targetPath, linkPath, 'junction');
  createdCandidate = true;
  return createTransition(linkPath, previousMount, createdCandidate, replacedTarget);
}

function createTransition(
  linkPath: string,
  previousMount: string | undefined,
  createdCandidate: boolean,
  replacedTarget: string | undefined,
): ActiveGameMountTransition {
  let settled = false;
  return {
    mountPath: linkPath,
    commit() {
      if (settled) return;
      // The candidate Pack binding is already committed at this point. Old
      // mount cleanup must not turn that success into a cross-layer rollback;
      // retaining an extra generated mount is safer than splitting Pack from
      // the mount/controller authority.
      settled = true;
      if (previousMount !== undefined && previousMount !== linkPath) {
        try {
          removeGeneratedMount(previousMount);
        } catch (error) {
          console.warn('[forgeax] failed to clean previous active-game mount:', error);
        }
      }
    },
    rollback() {
      if (settled) return;
      if (createdCandidate) removeGeneratedMount(linkPath);
      if (replacedTarget !== undefined) {
        symlinkSync(replacedTarget, linkPath, 'junction');
      }
      settled = true;
    },
  };
}

/**
 * Immediate setup used only during process boot, before a previous committed
 * runtime exists. Runtime game switches must use stageSingleGameRootFarm.
 */
export function setupSingleGameRootFarm(request: ActiveGameMountRequest): string {
  const transition = stageSingleGameRootFarm(request);
  transition.commit();
  return transition.mountPath;
}
