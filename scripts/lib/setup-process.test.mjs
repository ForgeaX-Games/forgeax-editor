import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PNPM_FETCH_RETRIES,
  DEFAULT_PNPM_NETWORK_CONCURRENCY,
  engineInstallEnv,
  runSupervisedCommand,
} from './setup-process.ts';

describe('setup process supervision', () => {
  test('bounds pnpm network pressure without overriding explicit environment settings', () => {
    expect(engineInstallEnv({})).toMatchObject({
      PNPM_CONFIG_NETWORK_CONCURRENCY: DEFAULT_PNPM_NETWORK_CONCURRENCY,
      PNPM_CONFIG_FETCH_RETRIES: DEFAULT_PNPM_FETCH_RETRIES,
      PNPM_CONFIG_IGNORE_WORKSPACE_CYCLES: 'true',
      SKIP_INSTALL_SIMPLE_GIT_HOOKS: '1',
    });
    expect(engineInstallEnv({
      PNPM_CONFIG_NETWORK_CONCURRENCY: '3',
      PNPM_CONFIG_FETCH_RETRIES: '4',
      PNPM_CONFIG_IGNORE_WORKSPACE_CYCLES: 'false',
      SKIP_INSTALL_SIMPLE_GIT_HOOKS: '0',
    })).toMatchObject({
      PNPM_CONFIG_NETWORK_CONCURRENCY: '3',
      PNPM_CONFIG_FETCH_RETRIES: '4',
      PNPM_CONFIG_IGNORE_WORKSPACE_CYCLES: 'false',
      SKIP_INSTALL_SIMPLE_GIT_HOOKS: '0',
    });
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
