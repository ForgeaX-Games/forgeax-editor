#!/usr/bin/env node
// gateway-fresh-page.mjs — verify EditGateway through a fresh browser page.
//
// Boots a headless browser at a running editor, waits for the DEV-only
// `globalThis.__forgeaxEval` channel, evaluates one snippet against it, awaits
// the result if the snippet was async, and prints the {ok,value|error} as JSON.
// This verification harness owns the page lifecycle. It is not a second
// Gateway mode: after creating the page, it reaches the same realm-local Gateway.
//
// Prereqs (once): from the editor repo, `bun run test:e2e:install` (installs the
// playwright-managed chromium), and a running editor with a scene open:
//   editor standalone  → `bun run dev:standalone`  (http://localhost:15290)
//
// Usage:
//   node gateway-fresh-page.mjs "gateway.listOps()"
//   node gateway-fresh-page.mjs --file snippet.js
//   FORGEAX_GATEWAY_URL=http://localhost:15290 node gateway-fresh-page.mjs "query({with:['Transform']})"
//   node gateway-fresh-page.mjs --raw "world.spawn(...)"  # unlock scope② (dev raw engine) first
//
// Flags (parsed by gateway-cli-common.parseArgs — unknown flags fail loudly):
//   --file <path>   read the snippet from a file instead of argv
//   --raw           call __forgeaxEval.unlockRawScope() before eval (grants world/renderer/assets)
//   --url <url>     override the target (else $FORGEAX_GATEWAY_URL, else :15290)
//   --timeout <ms>  __forgeaxEval readiness wait (default 30000)
//   --settle <ms>   wait after channel-ready for the scene to load (default 1500; 0 to skip)

import { parseArgs, readSnippet, printResult, resolveGpuArgs } from './gateway-cli-common.mjs';

const HELP = `Usage:
  node gateway-fresh-page.mjs "<gateway eval snippet>" [options]
  node gateway-fresh-page.mjs --file <path> [options]

Creates a fresh Playwright browser page, waits for its Editor Gateway, evaluates
one snippet, and closes the page. This is an isolated verification driver, not a
second Gateway mode.

Options:
  --file <path>   Read the snippet from a file
  --raw           Unlock DEV-only raw engine scope before eval
  --url <url>     Target editor URL (default: $FORGEAX_GATEWAY_URL or :15290)
  --timeout <ms>  Wait budget for __forgeaxEval readiness (default: 30000)
  --settle <ms>   Wait after readiness for scene loading (default: 1500)
  -h, --help      Show this help`;

const rawArgs = process.argv.slice(2);
if (rawArgs.includes('--help') || rawArgs.includes('-h') || rawArgs[0] === 'help') {
  console.log(HELP);
  process.exit(0);
}

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
// gateway.mjs `--settle`-into-code trap that motivated gateway-cli-common.mjs.
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
