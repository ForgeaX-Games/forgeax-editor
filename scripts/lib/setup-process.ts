import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';

const IS_WIN = process.platform === 'win32';

export const DEFAULT_PNPM_NETWORK_CONCURRENCY = '8';
export const DEFAULT_PNPM_FETCH_RETRIES = '2';
export const DEFAULT_HARNESS_SPARSE_DOCS = '1';

export type SetupEnvironmentSnapshot = {
  env: NodeJS.ProcessEnv;
  effectiveSparseValue: string;
  valueSource: 'default' | 'explicit';
};

/**
 * Resolve setup selectors once so every install process consumes one snapshot.
 * The public projection names this value effectiveSparseValue and records
 * whether it came from the default or an explicit environment value.
 */
export function resolveSetupEnvironment(env: NodeJS.ProcessEnv): SetupEnvironmentSnapshot {
  const configuredSparseValue = env.FORGEAX_HARNESS_SPARSE_DOCS;
  const valueSource = configuredSparseValue === undefined ? 'default' : 'explicit';
  const effectiveSparseValue = configuredSparseValue ?? DEFAULT_HARNESS_SPARSE_DOCS;
  return {
    env: {
      ...env,
      FORGEAX_HARNESS_SPARSE_DOCS: effectiveSparseValue,
    },
    effectiveSparseValue,
    valueSource,
  };
}

export function isHarnessSyncFailure(output: string): boolean {
  return output.includes('FORGEAX_HARNESS_DIVERGED');
}

/** Identify Bun's transient simple-git-hooks package-store entry failure. */
export function isSimpleGitHooksEnoent(output: string): boolean {
  return output.includes('simple-git-hooks') && output.includes('ENOENT');
}

export function engineInstallEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    PNPM_CONFIG_NETWORK_CONCURRENCY:
      env.PNPM_CONFIG_NETWORK_CONCURRENCY ?? DEFAULT_PNPM_NETWORK_CONCURRENCY,
    PNPM_CONFIG_FETCH_RETRIES:
      env.PNPM_CONFIG_FETCH_RETRIES ?? DEFAULT_PNPM_FETCH_RETRIES,
    // @forgeax/engine-physics intentionally lazy-loads Rapier backends from
    // the interface package while those backends import the interface types.
    // pnpm 11 exposes this only as a config/env option, so scope the known
    // cycle allowance to this engine install rather than repository-wide pnpm.
    PNPM_CONFIG_IGNORE_WORKSPACE_CYCLES:
      env.PNPM_CONFIG_IGNORE_WORKSPACE_CYCLES ?? 'true',
    // A fresh engine checkout has no dist/ yet. pnpm otherwise emits one
    // warning for every package bin whose target is created by the later
    // build step; keep setup output actionable while preserving non-zero
    // failures.
    PNPM_CONFIG_LOGLEVEL: env.PNPM_CONFIG_LOGLEVEL ?? 'error',
    // The engine is a git submodule, so its `.git` is a gitfile rather than a
    // hooks directory. Hook installation belongs to the editor root checkout.
    SKIP_INSTALL_SIMPLE_GIT_HOOKS:
      env.SKIP_INSTALL_SIMPLE_GIT_HOOKS ?? '1',
  };
}

function terminateProcessTree(pid: number): void {
  if (IS_WIN) {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // The child may have exited between the signal and cleanup.
  }
}

export type SupervisedCommandResult = {
  status: number;
  interrupted: boolean;
};

type SupervisedCommandOptions = Pick<SpawnOptions, 'cwd' | 'env' | 'shell' | 'stdio'> & {
  signal?: AbortSignal;
};

export function runSupervisedCommand(
  command: string,
  args: readonly string[],
  options: SupervisedCommandOptions = {},
): Promise<SupervisedCommandResult> {
  return new Promise((resolve, reject) => {
    const { signal: abortSignal, ...spawnOptions } = options;
    const child = spawn(command, [...args], {
      ...spawnOptions,
      detached: true,
      shell: options.shell ?? IS_WIN,
      stdio: options.stdio ?? 'inherit',
    });
    let interrupted = false;
    let settled = false;

    const stop = (): void => {
      if (interrupted || child.pid === undefined) return;
      interrupted = true;
      terminateProcessTree(child.pid);
    };
    const onSigint = (): void => stop();
    const onSigterm = (): void => stop();
    const onAbort = (): void => stop();

    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (abortSignal?.aborted) stop();

    const cleanup = (): void => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      abortSignal?.removeEventListener('abort', onAbort);
    };

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        status: code ?? (interrupted || signal ? 130 : 1),
        interrupted,
      });
    });
  });
}
