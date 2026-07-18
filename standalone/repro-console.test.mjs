// Standalone editor (:15290) console-health assertion.
//
// TDD anchor for the "很多报错" regression: launches the standalone shell in
// headless chromium, classifies every console/page error, and asserts ZERO of
// the real-bug categories. WebGPU RhiError is the documented headless-no-GPU
// limitation and is explicitly allowlisted (not a refactor defect).
//
// Run from the editor package dir so `@playwright/test` resolves:
//   node standalone/repro-console.test.mjs
// Requires :15290 (standalone) + :15280 (edit-runtime) already listening.

import { chromium } from '@playwright/test';

const URL = process.env.URL || 'http://localhost:15290/';

const browser = await chromium.launch();
const page = await browser.newContext().then((c) => c.newPage());

const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 }).catch((e) => pageErrors.push('GOTO: ' + e.message));
await page.waitForTimeout(3000);

// Ghost-iframe check (#5): the standalone host must NOT create a body-level
// viewport iframe. The real viewport lives inside the dock (renderEdit →
// `.dv-react-part` > iframe, proxied via :15290). A `body > iframe` is the
// leftover mountStandalone() ghost — cross-origin to :15280, URL missing the
// /editor base, running a second engine instance.
const ghostCount = await page.locator('body > iframe').count();
const ghostSrc = ghostCount ? await page.locator('body > iframe').first().getAttribute('src') : null;

await browser.close();

const all = [...pageErrors, ...consoleErrors];

// Allowlist: headless chromium has no GPU, so the WebGPU render loop throws.
// Not a refactor defect — see standalone/main.tsx header.
const isAllowed = (e) => /RhiError|webgpu|WebGPU|GPUDevice|createBindGroup/.test(e);

const bugs = {
  'JSON-parse-of-HTML (#1/#2: missing /api handling)':
    all.filter((e) => /is not valid JSON|Unexpected token '<'/.test(e)),
  'HMR-websocket-to-wrong-port (#3: clientPort 18920)':
    all.filter((e) => /failed to connect to websocket|WebSocket.*1892\d|ERR_CONNECTION_REFUSED.*1892\d|WebSocket closed without opened/.test(e)),
  'failed-PUT-without-backend (#4: workspace-layout 404)':
    all.filter((e) => /Failed to load resource.*404|404.*workspace-layout/.test(e)),
};
const other = all.filter((e) => !isAllowed(e)
  && !bugs['JSON-parse-of-HTML (#1/#2: missing /api handling)'].includes(e)
  && !bugs['HMR-websocket-to-wrong-port (#3: clientPort 18920)'].includes(e));

let failed = false;
for (const [name, list] of Object.entries(bugs)) {
  const n = list.length;
  console.log(`${n === 0 ? '✅' : '❌'} ${name}: ${n}`);
  if (n > 0) { failed = true; [...new Set(list)].slice(0, 3).forEach((e) => console.log('     • ' + e.split('\n')[0])); }
}
console.log(`${other.length === 0 ? '✅' : '⚠️ '} other (non-allowlisted): ${other.length}`);
[...new Set(other)].slice(0, 8).forEach((e) => console.log('     • ' + e.split('\n')[0]));

console.log(`${ghostCount === 0 ? '✅' : '❌'} no cross-origin body>iframe ghost (#5): count=${ghostCount}${ghostSrc ? ' src=' + ghostSrc : ''}`);
if (ghostCount > 0) failed = true;

process.exit(failed ? 1 : 0);
