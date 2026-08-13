import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const playwrightConfig = readFileSync(resolve(root, 'playwright.config.ts'), 'utf8');
const strictPlaywrightConfig = readFileSync(resolve(root, 'playwright.smoke.config.ts'), 'utf8');
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

test('parallel sample and template Vite stacks use isolated optimizer roots', () => {
  expect(playwrightConfig).toContain("const e2eSampleViteCacheRoot = join(e2eTempRoot, 'vite-cache', 'sample');");
  expect(playwrightConfig).toContain("const e2eTemplateViteCacheRoot = join(e2eTempRoot, 'vite-cache', 'template');");
  expect(playwrightConfig).toContain('FORGEAX_VITE_CACHE_ROOT: e2eSampleViteCacheRoot');
  expect(playwrightConfig).toContain('FORGEAX_VITE_CACHE_ROOT: e2eTemplateViteCacheRoot');
  expect(readFileSync(resolve(root, 'vite.config.ts'), 'utf8')).toContain(
    "resolve(process.env.FORGEAX_VITE_CACHE_ROOT, 'standalone-host')",
  );
  expect(readFileSync(resolve(root, 'packages/edit-runtime/vite.config.ts'), 'utf8')).toContain(
    "resolve(process.env.FORGEAX_VITE_CACHE_ROOT, 'edit-runtime')",
  );
  expect(readFileSync(resolve(root, 'packages/play-runtime/vite.config.ts'), 'utf8')).toContain(
    "resolve(process.env.FORGEAX_VITE_CACHE_ROOT, 'play-runtime')",
  );
});

test('strict smoke uses the pinned Bun CLI without a bunx shim', () => {
  expect(strictPlaywrightConfig).not.toContain('bunx');
  expect(strictPlaywrightConfig).toContain('command: `bun x vite --port ${enginePort} --strictPort`');
});
