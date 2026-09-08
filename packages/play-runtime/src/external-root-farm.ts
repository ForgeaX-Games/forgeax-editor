import {
  lstatSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { resolve } from 'node:path';

export function resolveExternalRootFarmRuntimeRoot(
  configRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const packagedWorkspace = env.FORGEAX_ENGINE_WORKSPACE_ROOT?.trim();
  return resolve(packagedWorkspace || configRoot);
}

function sameRealPath(left: string, right: string): boolean {
  try {
    return realpathSync.native(left) === realpathSync.native(right);
  } catch {
    return false;
  }
}

/**
 * Keep an immutable external asset root addressable below the Vite root.
 *
 * Desktop materialization and Vite startup can overlap with a project bind.
 * This operation is deliberately idempotent so the binding owner can repair a
 * missing, dangling, or stale farm immediately before Pack scans its roots.
 */
export function setupExternalRootFarm(
  runtimeRoot: string,
  linkName: string,
  targetPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const linkPath = resolve(runtimeRoot, linkName);
  const target = resolve(targetPath);
  if (!statSync(target).isDirectory()) {
    throw new Error(`external root farm target is not a directory: ${target}`);
  }

  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      if (sameRealPath(linkPath, target)) return linkPath;
      unlinkSync(linkPath);
    } else if (stat.isFile()) {
      // Git on Windows can check a symlink out as a text-file placeholder.
      unlinkSync(linkPath);
    } else {
      throw new Error(`refusing to replace non-symlink external root farm: ${linkPath}`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }

  symlinkSync(target, linkPath, platform === 'win32' ? 'junction' : 'dir');
  return linkPath;
}
