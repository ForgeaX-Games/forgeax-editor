import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PNPM_FETCH_RETRIES,
  DEFAULT_PNPM_NETWORK_CONCURRENCY,
  engineInstallEnv,
  isHarnessSyncFailure,
  resolveSetupEnvironment,
  runSupervisedCommand,
} from '../setup-process.ts';

describe('setup process supervision', () => {
  test('bounds pnpm network pressure without overriding explicit environment settings', () => {
    expect(engineInstallEnv({})).toMatchObject({
      PNPM_CONFIG_NETWORK_CONCURRENCY: DEFAULT_PNPM_NETWORK_CONCURRENCY,
      PNPM_CONFIG_FETCH_RETRIES: DEFAULT_PNPM_FETCH_RETRIES,
      PNPM_CONFIG_IGNORE_WORKSPACE_CYCLES: 'true',
      PNPM_CONFIG_LOGLEVEL: 'error',
      SKIP_INSTALL_SIMPLE_GIT_HOOKS: '1',
    });
    expect(engineInstallEnv({
      PNPM_CONFIG_NETWORK_CONCURRENCY: '3',
      PNPM_CONFIG_FETCH_RETRIES: '4',
      PNPM_CONFIG_IGNORE_WORKSPACE_CYCLES: 'false',
      PNPM_CONFIG_LOGLEVEL: 'silent',
      SKIP_INSTALL_SIMPLE_GIT_HOOKS: '0',
    })).toMatchObject({
      PNPM_CONFIG_NETWORK_CONCURRENCY: '3',
      PNPM_CONFIG_FETCH_RETRIES: '4',
      PNPM_CONFIG_IGNORE_WORKSPACE_CYCLES: 'false',
      PNPM_CONFIG_LOGLEVEL: 'silent',
      SKIP_INSTALL_SIMPLE_GIT_HOOKS: '0',
    });
  });

  test('recognizes harness divergence as the recoverable install failure', () => {
    expect(isHarnessSyncFailure('[harness:sync] FORGEAX_HARNESS_DIVERGED: local state')).toBe(true);
    expect(isHarnessSyncFailure('simple-git-hooks: package.json not found')).toBe(false);
  });

  test('resolves the default sparse selector without changing explicit values', () => {
    expect(resolveSetupEnvironment({}).effectiveSparseValue).toBe('1');
    expect(resolveSetupEnvironment({}).valueSource).toBe('default');
    expect(resolveSetupEnvironment({FORGEAX_HARNESS_SPARSE_DOCS: '0'})).toMatchObject({
      effectiveSparseValue: '0',
      valueSource: 'explicit',
    });
  });

  test('keeps sparse and harness-skip values when adding Engine pnpm settings', () => {
    const env = {
      FORGEAX_HARNESS_SPARSE_DOCS: '0',
      FORGEAX_SKIP_HARNESS_SYNC: '1',
      FORGEAX_SKIP_EDITOR_BUN_INSTALL: '1',
    };
    expect(engineInstallEnv(env)).toMatchObject(env);
  });

  test('terminates the spawned process tree when setup is interrupted', async () => {
    const controller = new AbortController();
    const command = runSupervisedCommand(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000)'],
      {
        shell: false,
        stdio: 'ignore',
        signal: controller.signal,
      },
    );

    setTimeout(() => controller.abort(), 100);
    let timeout;
    try {
      const result = await Promise.race([
        command,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('supervised child did not terminate')),
            5_000,
          );
        }),
      ]);
      expect(result.interrupted).toBe(true);
      expect(result.status).not.toBe(0);
    } finally {
      clearTimeout(timeout);
    }
  });
});
