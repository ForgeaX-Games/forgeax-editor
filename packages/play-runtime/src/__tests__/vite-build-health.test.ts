import { expect, it } from 'bun:test';
import { createBuildFailureDeduper } from '../vite-build-health';

it('installs Vite build health before Play boot begins', async () => {
  const source = await Bun.file(new URL('../main.ts', import.meta.url)).text();
  const healthImport = source.indexOf("import './vite-build-health';");
  const bootAwait = source.indexOf('await loadRuntimeBinding()');
  expect(healthImport).toBeGreaterThanOrEqual(0);
  expect(bootAwait).toBeGreaterThan(healthImport);
  const healthSource = await Bun.file(new URL('../vite-build-health.ts', import.meta.url)).text();
  expect(healthSource).toContain("querySelectorAll('vite-error-overlay')");
});

it('never observes the whole document subtree', () => {
  // Vite injects <vite-error-overlay> as a direct child of <body>. Observing
  // documentElement with subtree:true fires on EVERY DOM mutation, and Play
  // mutates the DOM continuously — each mutation would then run a whole-document
  // querySelectorAll, growing the dev server until the OOM killer takes it
  // (`[WebServer] Killed` on heavy CI runners). Keep the observer body-scoped.
  const healthSource = require('node:fs').readFileSync(
    new URL('../vite-build-health.ts', import.meta.url), 'utf8',
  ) as string;
  expect(healthSource).not.toContain('subtree: true');
  expect(healthSource).not.toContain('observe(document.documentElement');
  expect(healthSource).toContain('observe(document.body, { childList: true })');
});

it('counts the Vite event and overlay for one transform as one build failure', () => {
  const accept = createBuildFailureDeduper(1_000);
  expect(accept('Transform failed', 10_000)).toBe('Transform failed');
  expect(accept('[plugin:vite:oxc] Transform failed', 10_050)).toBeNull();
  expect(accept('A later transform failed', 11_001)).toBe('A later transform failed');
});

it('never drops a DIFFERENT build error inside the dedupe window', () => {
  // main 的原实现对每条 vite:error 都发 VAG_CONSOLE。去重只允许合并「同一次
  // transform 的两个来源」,不能把 1 秒内两个不同的失败压成一条 —— 那会丢掉
  // main 一直在报的信息。
  const accept = createBuildFailureDeduper(1_000);
  expect(accept("Failed to resolve import './a'", 0)).toBe("Failed to resolve import './a'");
  expect(accept("Failed to resolve import './b'", 200)).toBe("Failed to resolve import './b'");
});
