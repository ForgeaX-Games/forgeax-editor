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
// Flags (parsed by gateway-cli-common.parseArgs — unknown flags fail loudly):
//   --file <path>   read the snippet from a file instead of argv
//   --raw           call __forgeaxEval.unlockRawScope() before eval (grants world/renderer/assets)
//   --url <url>     override the target (else $FORGEAX_GATEWAY_URL, else :15290)
//   --timeout <ms>  __forgeaxEval readiness wait (default 30000)
//   --settle <ms>   wait after channel-ready for the scene to load (default 1500; 0 to skip)

import { parseArgs, readSnippet, printResult, resolveGpuArgs } from './gateway-cli-common.mjs';

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

// Strict spec-driven parse (shared SSOT). Unknown flags fail loudly (exit 2) so a
// flag this script does not declare can never leak into the code snippet — the
// gateway-live `--settle`-into-code trap that motivated gateway-cli-common.mjs.
const { code: posCode, flags } = parseArgs(process.argv, {
  boolean: ['raw'],
  value: ['file', 'url', 'timeout', 'settle'],
  number: ['timeout', 'settle'],
});
const url = flags.url ?? process.env.FORGEAX_GATEWAY_URL ?? 'http://localhost:15290';
const timeout = flags.timeout ?? 30000;
const settle = flags.settle ?? 1500;
const code = readSnippet({ code: posCode, file: flags.file });

const launchOpts = { headless: true, args: resolveGpuArgs() };
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
  await page.waitForFunction(() => !!globalThis.__forgeaxEval, { timeout });
  // The channel mounts before the scene finishes async loadByGuid → instantiate,
  // so scene-dependent queries (entity counts, hierarchy) run too early right
  // after readiness. Settle briefly; --settle 0 for scene-independent calls.
  if (settle > 0) await page.waitForTimeout(settle);

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
    { snippet: code, raw: flags.raw ?? false },
  );

  printResult(result);
} finally {
  await browser.close();
}
