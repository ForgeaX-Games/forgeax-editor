import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const config = readFileSync(resolve(import.meta.dir, '../../../playwright.config.ts'), 'utf8');
// Evaluate the real declaration without booting the config's game fixtures or
// changing this test runner's process.env/platform for simulated host cases.
const declaration = config.match(/const e2eBrowserChannel = ([\s\S]*?);/)?.[1];

function channel(platform: string, env: Record<string, string> = {}): unknown {
  expect(declaration).toBeDefined();
  return runInNewContext(declaration!, { process: { platform, env } });
}

test('local macOS uses full Chromium instead of the default headless shell', () => {
  expect(channel('darwin')).toBe('chromium');
  expect(channel('darwin', { FORGEAX_BROWSER_HEADLESS: '1' })).toBe('chromium');
  expect(channel('darwin', { FORGEAX_BROWSER_HEADLESS: '0' })).toBe('chromium');
  expect(config).toContain('...(e2eBrowserChannel ? { channel: e2eBrowserChannel } : {})');
  expect(config).toContain("headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0'");
});

test('explicit channels win on every platform, including CI', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    for (const CI of ['', 'true']) {
      expect(channel(platform, { CI, FORGEAX_E2E_BROWSER_CHANNEL: 'chrome-beta' })).toBe('chrome-beta');
      // Preserve the existing explicit empty-string opt-out to Playwright's default.
      expect(channel(platform, { CI, FORGEAX_E2E_BROWSER_CHANNEL: '' })).toBe('');
    }
  }
});

test('CI and unverified local platforms retain their existing default', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    expect(channel(platform, { CI: 'true' })).toBeUndefined();
    expect(channel(platform, { CI: '1' })).toBeUndefined();
  }
  expect(channel('linux')).toBeUndefined();
  expect(channel('win32')).toBeUndefined();
});
