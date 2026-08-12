import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const playwrightConfig = readFileSync(resolve(root, 'playwright.config.ts'), 'utf8');
const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
const smokeStart = workflow.indexOf('- name: Boot + Play + Content Browser + Save + Mesh Preview smoke (games/sample)');
const strictStart = workflow.indexOf('- name: Strict editor smoke (game-default + games/sample)', smokeStart);
const smokeStep = workflow.slice(smokeStart, strictStart);

test('default smoke has an explicit CI escape from the Chromium headless GPU path', () => {
  expect(smokeStart).toBeGreaterThanOrEqual(0);
  expect(strictStart).toBeGreaterThan(smokeStart);
  expect(playwrightConfig).toContain("headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0'");
  expect(playwrightConfig).toContain("'--use-vulkan=swiftshader'");
  expect(playwrightConfig).not.toContain("'--use-angle=swiftshader'");
  expect(smokeStep).toContain('FORGEAX_E2E_BROWSER_CHANNEL: chrome-beta');
  expect(smokeStep).toContain("FORGEAX_BROWSER_HEADLESS: '0'");
  expect(smokeStep).toContain('xvfb-run -a');
});
