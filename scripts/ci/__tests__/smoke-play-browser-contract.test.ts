import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const playwrightConfig = readFileSync(resolve(root, 'playwright.config.ts'), 'utf8');
const strictPlaywrightConfig = readFileSync(resolve(root, 'playwright.smoke.config.ts'), 'utf8');
const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
const smokeStart = workflow.indexOf('- name: Broad core smoke (games/sample)');
const templateStart = workflow.indexOf('- name: New-game template smoke (fresh canonical template)', smokeStart);
const broadPlayStart = workflow.indexOf('- name: Broad Play runtime smoke (games/sample)', smokeStart);
const broadAssetsStart = workflow.indexOf('- name: Broad asset smoke (games/sample)', broadPlayStart);
const strictStart = workflow.indexOf('- name: Strict editor smoke (immediate + title-gated gameplay)', smokeStart);
const smokeStep = workflow.slice(smokeStart, strictStart);

test('broad smoke shards have an explicit CI escape from the Chromium headless GPU path', () => {
  expect(smokeStart).toBeGreaterThanOrEqual(0);
  expect(templateStart).toBeGreaterThan(smokeStart);
  expect(broadPlayStart).toBeGreaterThan(smokeStart);
  expect(broadAssetsStart).toBeGreaterThan(broadPlayStart);
  expect(strictStart).toBeGreaterThan(smokeStart);
  expect(playwrightConfig).toContain("headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0'");
  expect(playwrightConfig).toContain("'--use-vulkan=swiftshader'");
  expect(playwrightConfig).not.toContain("'--use-angle=swiftshader'");
  expect(smokeStep.match(/FORGEAX_E2E_BROWSER_CHANNEL: chrome-beta/g)?.length).toBe(5);
  expect(smokeStep.match(/FORGEAX_BROWSER_HEADLESS: '0'/g)?.length).toBe(5);
  expect(smokeStep.match(/xvfb-run -a/g)?.length).toBe(5);
});

test('sample-only broad shards do not boot the unrelated template stack', () => {
  const broadCore = workflow.slice(smokeStart, templateStart);
  const broadPlay = workflow.slice(broadPlayStart, broadAssetsStart);
  const broadAssets = workflow.slice(broadAssetsStart, strictStart);
  expect(broadCore).toContain("FORGEAX_E2E_SKIP_TEMPLATE_STACK: '1'");
  expect(broadPlay).toContain("FORGEAX_E2E_SKIP_TEMPLATE_STACK: '1'");
  expect(broadAssets).toContain("FORGEAX_E2E_SKIP_TEMPLATE_STACK: '1'");
  const template = workflow.slice(templateStart, broadPlayStart);
  expect(template).toContain("FORGEAX_E2E_SKIP_SAMPLE_STACK: '1'");
  expect(template).toContain('apps/standalone/e2e/__tests__/new-game-template-journey.spec.ts');
});

test('parallel sample and template Vite stacks use isolated optimizer roots', () => {
  expect(playwrightConfig).toContain("const e2eSkipSampleStack = process.env.FORGEAX_E2E_SKIP_SAMPLE_STACK === '1';");
  expect(playwrightConfig).toContain('...(e2eSkipSampleStack ? [] : [{');
  expect(playwrightConfig).toContain('...(e2eSkipTemplateStack ? [] : [{');
  expect(playwrightConfig).toContain("const e2eSampleViteCacheRoot = join(e2eTempRoot, 'vite-cache', 'sample');");
  expect(playwrightConfig).toContain("const e2eTemplateViteCacheRoot = join(e2eTempRoot, 'vite-cache', 'template');");
  expect(playwrightConfig).toContain('FORGEAX_VITE_CACHE_ROOT: e2eSampleViteCacheRoot');
  expect(playwrightConfig).toContain('FORGEAX_VITE_CACHE_ROOT: e2eTemplateViteCacheRoot');
  const standaloneVite = readFileSync(resolve(root, 'vite.config.ts'), 'utf8');
  expect(standaloneVite).toContain(
    "resolve(process.env.FORGEAX_VITE_CACHE_ROOT, 'standalone-host')",
  );
  expect(standaloneVite).toContain("const NOBLE_HASHES_DIR = realpathSync(");
  expect(standaloneVite).toContain("'@noble/hashes': NOBLE_HASHES_DIR");
  expect(readFileSync(resolve(root, 'packages/edit-runtime/vite.config.ts'), 'utf8')).toContain(
    "resolve(process.env.FORGEAX_VITE_CACHE_ROOT, 'edit-runtime')",
  );
  expect(readFileSync(resolve(root, 'packages/play-runtime/vite.config.ts'), 'utf8')).toContain(
    "resolve(process.env.FORGEAX_VITE_CACHE_ROOT, 'play-runtime')",
  );
});

test('strict smoke uses the pinned Bun CLI without a bunx shim', () => {
  expect(strictPlaywrightConfig).not.toContain('bunx');
  expect(strictPlaywrightConfig).toContain("process.env.FORGEAX_SMOKE_VITE_RUNTIME === 'node'");
  expect(strictPlaywrightConfig).toContain('if (!useNodeViteRuntime) return `bun x vite${args}`;');
  expect(workflow).toContain('FORGEAX_SMOKE_VITE_RUNTIME: node');
});

test('independent Play producers reuse each host runtime scope and generation', () => {
  expect(playwrightConfig).toContain('const e2eTemplateRuntimeScopeId = process.env.FORGEAX_E2E_TEMPLATE_RUNTIME_SCOPE_ID');
  expect(playwrightConfig).toContain('const e2eTemplateRuntimeGeneration = process.env.FORGEAX_E2E_TEMPLATE_RUNTIME_GENERATION');
  const count = (needle: string): number => playwrightConfig.split(needle).length - 1;
  expect(count('FORGEAX_RUNTIME_SCOPE_ID: e2eRuntimeScopeId')).toBe(2);
  expect(count('FORGEAX_RUNTIME_GENERATION: e2eRuntimeGeneration')).toBe(2);
  expect(count('FORGEAX_RUNTIME_SCOPE_ID: e2eTemplateRuntimeScopeId')).toBe(2);
  expect(count('FORGEAX_RUNTIME_GENERATION: e2eTemplateRuntimeGeneration')).toBe(2);
});
