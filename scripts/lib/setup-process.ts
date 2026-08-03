import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';

const IS_WIN = process.platform === 'win32';

export const DEFAULT_PNPM_NETWORK_CONCURRENCY = '8';
export const DEFAULT_PNPM_FETCH_RETRIES = '2';

export function engineInstallEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    PNPM_CONFIG_NETWORK_CONCURRENCY:
      env.PNPM_CONFIG_NETWORK_CONCURRENCY ?? DEFAULT_PNPM_NETWORK_CONCURRENCY,
    PNPM_CONFIG_FETCH_RETRIES:
      env.PNPM_CONFIG_FETCH_RETRIES ?? DEFAULT_PNPM_FETCH_RETRIES,
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
