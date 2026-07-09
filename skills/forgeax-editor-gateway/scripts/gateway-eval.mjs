#!/usr/bin/env node
// gateway-eval.mjs — drive the editor EditGateway headlessly from a script.
//
// Boots a headless browser at a running editor, waits for the DEV-only
// `globalThis.__forgeaxEval` channel, evaluates one snippet against it, awaits
// the result if the snippet was async, and prints the {ok,value|error} as JSON.
// This is the reusable harness the SKILL.md examples assume — later agents run
// gateway ops / queries / raw-scope writes without re-deriving the boot dance.
//
// Prereqs (once): from the editor repo, `bun run test:e2e:install` (installs the
// playwright-managed chromium), and a running editor with a scene open:
//   editor standalone  → `bun run dev:standalone`  (http://localhost:15290, no onboarding)
//   studio embed        → `bun fx start`            (http://localhost:18920, onboarding auto-skipped below)
//
// Usage:
//   node gateway-eval.mjs "gateway.listOps()"
//   node gateway-eval.mjs --file snippet.js
//   FORGEAX_GATEWAY_URL=http://localhost:18920 node gateway-eval.mjs "query({with:['Transform']})"
//   node gateway-eval.mjs --raw "world.spawn(...)"        # unlock scope② (dev raw engine) first
//
// Flags:
//   --file <path>   read the snippet from a file instead of argv
//   --raw           call __forgeaxEval.unlockRawScope() before eval (grants world/renderer/assets)
//   --url <url>     override the target (else $FORGEAX_GATEWAY_URL, else :15290)
//   --timeout <ms>  __forgeaxEval readiness wait (default 30000)

import { readFileSync } from 'node:fs';

// Resolve chromium from `playwright` (the editor's e2e devDep, present after
// `bun run test:e2e:install`). If only `playwright-core` is available (e.g. a
// bare checkout), point FORGEAX_PLAYWRIGHT at its index + FORGEAX_CHROMIUM at a
// chrome binary. Dynamic import so a missing package fails with a clear message.
const pwMod = process.env.FORGEAX_PLAYWRIGHT ?? 'playwright';
let chromium;
try {
  const mod = await import(pwMod);
  // playwright is ESM (named export); playwright-core is CJS (under .default).
  chromium = mod.chromium ?? mod.default?.chromium;
} catch (err) {
  console.error(
    `cannot import '${pwMod}': ${err.message}\n` +
      `install it (editor repo: \`bun run test:e2e:install\`), or set ` +
      `FORGEAX_PLAYWRIGHT to a playwright-core index.js + FORGEAX_CHROMIUM to a chrome binary.`,
  );
  process.exit(2);
}

function parseArgs(argv) {
  const a = { raw: false, url: undefined, file: undefined, timeout: 30000, settle: 1500, code: undefined };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--raw') a.raw = true;
    else if (t === '--file') a.file = argv[++i];
    else if (t === '--url') a.url = argv[++i];
    else if (t === '--timeout') a.timeout = Number(argv[++i]);
    else if (t === '--settle') a.settle = Number(argv[++i]);
    else if (!t.startsWith('--')) a.code = t;
  }
  return a;
}

const args = parseArgs(process.argv);
const url = args.url ?? process.env.FORGEAX_GATEWAY_URL ?? 'http://localhost:15290';
const code = args.file ? readFileSync(args.file, 'utf8') : args.code;
if (!code) {
  console.error('no snippet — pass code as an argument or --file <path>');
  process.exit(2);
}

const launchOpts = { headless: true };
if (process.env.FORGEAX_CHROMIUM) launchOpts.executablePath = process.env.FORGEAX_CHROMIUM;
const browser = await chromium.launch(launchOpts);
try {
  const ctx = await browser.newContext();
  // Studio (:18920) gates the editor behind a first-run model-setup overlay;
  // pre-seed the "seen" flag so the editor boots. Harmless on editor standalone.
  await ctx.addInitScript(() => {
    try { localStorage.setItem('forgeax.onboarding.seen', '1'); } catch { /* private mode */ }
  });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!globalThis.__forgeaxEval, { timeout: args.timeout });
  // The channel mounts before the scene finishes async loadByGuid → instantiate,
  // so scene-dependent queries (entity counts, hierarchy) run too early right
  // after readiness. Settle briefly; --settle 0 for scene-independent calls.
  if (args.settle > 0) await page.waitForTimeout(args.settle);

  const result = await page.evaluate(
    async ({ snippet, raw }) => {
      const ev = globalThis.__forgeaxEval;
      if (raw) ev.unlockRawScope();
      const r = ev.eval(snippet);
      // Async snippets (those using `await` / `_import`) return {ok:true, value:<Promise>};
      // await the inner value so the caller sees the resolved result, not a Promise.
      if (r && r.ok && r.value && typeof r.value.then === 'function') {
        return { ok: true, value: await r.value };
      }
      return r;
    },
    { snippet: code, raw: args.raw },
  );

  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result && result.ok === false ? 1 : 0;
} finally {
  await browser.close();
}
