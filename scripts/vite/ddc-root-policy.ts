import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';

export interface DdcRootPolicy {
  readonly gameDir: string;
  readonly buildCacheRoot: string;
  readonly projectDdcRoot: string;
}

export interface DdcRootPolicyOptions {
  readonly buildCacheRoot?: string;
  /**
   * Optional explicit publication root for disposable hosts such as packaging
   * parity. Normal editor/game hosts leave this unset so publication remains
   * under the canonical game directory.
   */
  readonly projectDdcRoot?: string;
}

export interface DdcRootPolicyError extends Error {
  readonly code:
    | 'ddc-game-root-required'
    | 'ddc-game-root-invalid'
    | 'ddc-root-absolute-required';
  readonly expected: string;
  readonly actual?: string;
  readonly hint: string;
}

function policyError(
  code: DdcRootPolicyError['code'],
  message: string,
  expected: string,
  hint: string,
  actual?: string,
): DdcRootPolicyError {
  return Object.assign(new Error(message), { code, expected, hint, ...(actual === undefined ? {} : { actual }) });
}

/** Resolve one real game directory; no root may be inferred from cwd or a slug. */
export function canonicalizeGameDir(gameDir: string): string {
  const input = gameDir.trim();
  if (input.length === 0) {
    throw policyError(
      'ddc-game-root-required',
      'a canonical game directory is required before selecting DDC roots',
      'an existing game directory',
      'inject gameDir from the host before starting a fixed or serving runtime',
    );
  }

  const candidate = resolve(input);
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw policyError(
      'ddc-game-root-invalid',
      'gameDir must resolve to an existing directory',
      'an existing game directory',
      'repair the host gameDir before selecting DDC roots',
      candidate,
    );
  }
  return realpathSync.native(candidate);
}

/**
 * Resolve the host-owned build cache without inferring a project identity.
 * Dynamic hosts call this before a game is selected; their later bind injects
 * the canonical projectDdcRoot separately.
 */
export function resolveDdcBuildCacheRoot(
  defaultBuildCacheRoot: string,
  options: DdcRootPolicyOptions = {},
): string {
  const configuredBuildRoot = options.buildCacheRoot ?? process.env.FORGEAX_DDC_BUILD_CACHE_ROOT;
  const buildCacheRoot = normalize(configuredBuildRoot ?? defaultBuildCacheRoot);
  if (!isAbsolute(buildCacheRoot)) {
    throw policyError(
      'ddc-root-absolute-required',
      'buildCacheRoot must be an absolute host-injected path',
      'an absolute build cache root',
      'inject an absolute buildCacheRoot or unset the shared-cache override',
      buildCacheRoot,
    );
  }
  return buildCacheRoot;
}

/**
 * Resolve the project publication root. The game-local path is the normal
 * owner; an explicit host-injected override is reserved for isolated,
 * disposable build/test runs so they cannot mutate a live game's DDC state.
 */
export function resolveDdcProjectRoot(
  canonicalGameDir: string,
  options: DdcRootPolicyOptions = {},
): string {
  const configuredProjectRoot = options.projectDdcRoot ?? process.env.FORGEAX_DDC_PROJECT_ROOT;
  const projectDdcRoot = normalize(
    configuredProjectRoot ?? resolve(canonicalGameDir, '.forgeax/ddc/v2'),
  );
  if (!isAbsolute(projectDdcRoot)) {
    throw policyError(
      'ddc-root-absolute-required',
      'projectDdcRoot must be an absolute host-injected path',
      'an absolute project DDC root',
      'inject an absolute projectDdcRoot or unset the disposable-root override',
      projectDdcRoot,
    );
  }
  return projectDdcRoot;
}

/**
 * Select the two host-owned roots. The default build root is game-local so a
 * missing shared cache never affects correctness; a host may opt into a
 * separate absolute shared CAS through FORGEAX_DDC_BUILD_CACHE_ROOT.
 */
export function resolveDdcRootPolicy(
  gameDir: string,
  options: DdcRootPolicyOptions = {},
): DdcRootPolicy {
  const canonicalGameDir = canonicalizeGameDir(gameDir);
  const projectDdcRoot = resolveDdcProjectRoot(canonicalGameDir, options);
  const buildCacheRoot = resolveDdcBuildCacheRoot(resolve(projectDdcRoot, 'build'), options);
  return { gameDir: canonicalGameDir, buildCacheRoot, projectDdcRoot };
}
