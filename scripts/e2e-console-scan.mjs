// e2e-console-scan.mjs — load the REAL standalone editor in headless chromium
// (with --game already running) and dump EVERY console error, page error, and
// failed network request with full URLs. Ad-hoc closed-loop debugging tool:
// run → read categories → fix → re-run until clean.
//
// Usage: bun scripts/e2e-console-scan.mjs   (requires :15290 + :15280 + :15281)

import { chromium } from '@playwright/test';

const URL = process.env.URL || 'http://127.0.0.1:15290/';

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
const succeededUrls = new Set(); // any URL that returned 2xx/304 at least once

page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('requestfailed', (r) => failedRequests.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText ?? '?'}`));
page.on('response', (r) => {
  const s = r.status();
  if (s < 400 || s === 304) succeededUrls.add(r.url());
  if (s >= 400) failedRequests.push(`${s} ${r.request().method()} ${r.url()}`);
});

const urlOf = (line) => line.replace(/^\d+ \w+ /, '').replace(/^\w+ /, '').split(' — ')[0];

console.log(`→ loading ${URL}`);
await page.goto(URL, { waitUntil: 'networkidle', timeout: 45000 }).catch((e) => pageErrors.push('GOTO: ' + e.message));
// let lazy effects / iframe boot settle
await page.waitForTimeout(5000);

await browser.close();

const dedupe = (arr) => [...new Set(arr)];

const section = (title, arr) => {
  const u = dedupe(arr);
  console.log(`\n${'='.repeat(60)}\n${title}: ${u.length} unique (${arr.length} total)\n${'='.repeat(60)}`);
  u.forEach((e) => console.log('  • ' + e.split('\n')[0].slice(0, 200)));
  return u;
};

const pe = section('PAGE ERRORS (uncaught)', pageErrors);
const ce = section('CONSOLE ERRORS', consoleErrors);
const fr = section('FAILED REQUESTS (>=400 / net fail)', failedRequests);

// Allowlist: headless chromium has no GPU → WebGPU render loop throws (documented).
// Also tolerate Vite cold-start `504 (Outdated Optimize Dep)` when nested deps are
// discovered after the first page load (same filter as e2e/games-smoke-helpers.ts).
const allowed = (e) =>
  /RhiError|webgpu|WebGPU|GPUDevice|createBindGroup|requestAdapter|GPUAdapter|Outdated Optimize Dep/i.test(e);
// Dev-only noise: React StrictMode double-mounts every effect, so iframe/HMR
// loads are torn down (net::ERR_ABORTED) and immediately re-issued. An aborted
// request whose SAME url also succeeded (2xx/304) elsewhere in the session is
// not a real failure — it's the discarded first mount. Filter those out.
const devAbortRetried = (e) => /ERR_ABORTED/.test(e) && succeededUrls.has(urlOf(e));
const realPage = pe.filter((e) => !allowed(e));
const realConsole = ce.filter((e) => !allowed(e));
const realReq = fr.filter((e) => !allowed(e) && !devAbortRetried(e));

console.log(`\n${'#'.repeat(60)}`);
console.log(`SUMMARY (excluding WebGPU-headless allowlist):`);
console.log(`  page errors:     ${realPage.length}`);
console.log(`  console errors:  ${realConsole.length}`);
console.log(`  failed requests: ${realReq.length}`);
console.log('#'.repeat(60));

const clean = realPage.length === 0 && realConsole.length === 0 && realReq.length === 0;
console.log(clean ? '\n✅ CLEAN' : '\n❌ ISSUES REMAIN');
process.exit(clean ? 0 : 1);
