// gateway-cli-common.mjs — SSOT for the shared plumbing of the two gateway CLI
// drivers (gateway-eval.mjs = headless playwright boot; gateway-live.mjs = POST to
// the live bridge relay). Both used to re-implement arg parsing, snippet reading,
// and the {ok,value|error} print + exit-code convention, and had DRIFTED:
//
//   - eval parsed flags with a per-flag switch; live did
//     `argv.filter(a => !a.startsWith('--')).join(' ')`, which silently swallowed
//     unknown flags but kept their bare VALUES as code. `--settle 0 "expr"` (a
//     eval-only flag) sent to live became `code = "0 expr"` → a cascade of bogus
//     SCRIPT_SYNTAX_ERROR / "0 is not a function". parseArgs() below is strict:
//     an undeclared flag fails loudly (exit 2) instead of masquerading as code.
//   - eval used `process.exitCode = ...`; live used `process.exit(...)`. Same
//     intent, two spellings. printResult() below is the one convention.
//
// Keep context-specific logic (browser boot vs relay POST, in-browser async
// unwrap) in the individual scripts — only genuinely common, drift-prone plumbing
// lives here.

import { readFileSync } from 'node:fs';

/**
 * Spec-driven CLI parser. `spec` declares exactly which flags THIS script accepts:
 *   { boolean: ['raw'], value: ['file','url','timeout','settle'], number: ['timeout','settle'] }
 *   - boolean[]: presence-only flags (`--raw` → flags.raw = true)
 *   - value[]:   `--flag <value>` flags (next argv token is the value)
 *   - number[]:  subset of value[] whose value is coerced with Number()
 * The first non-`--` token becomes the positional `code`.
 * An undeclared `--flag` is a hard error (exit 2) — a flag the script does not
 * declare can never leak into `code`. Returns { code, flags }.
 */
export function parseArgs(argv, spec = {}) {
  const boolean = new Set(spec.boolean ?? []);
  const value = new Set(spec.value ?? []);
  const number = new Set(spec.number ?? []);
  const known = new Set([...boolean, ...value]);

  const flags = {};
  let code;
  // argv is process.argv; skip node + script path.
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const name = t.slice(2);
      if (!known.has(name)) {
        const accepted = [...known].sort().map((f) => `--${f}`).join(', ') || '(none)';
        console.error(`unknown flag '${t}'. Accepted flags: ${accepted}`);
        process.exit(2);
      }
      if (boolean.has(name)) {
        flags[name] = true;
      } else {
        const raw = argv[++i];
        if (raw === undefined) {
          console.error(`flag '${t}' expects a value`);
          process.exit(2);
        }
        flags[name] = number.has(name) ? Number(raw) : raw;
      }
    } else if (code === undefined) {
      code = t;
    }
    // extra positionals after `code` are ignored (matches prior lenient behavior
    // for a single snippet arg; quote multi-token snippets).
  }
  return { code, flags };
}

/**
 * Resolve the JS snippet to run: `--file <path>` reads from disk, else the
 * positional `code`. Neither present → usage error (exit 2). `usage` customizes
 * the error line per script.
 */
export function readSnippet({ code, file }, usage = 'pass code as an argument or --file <path>') {
  if (file) return readFileSync(file, 'utf8');
  if (code) return code;
  console.error(`no snippet — ${usage}`);
  process.exit(2);
}

/**
 * The one print + exit convention: pretty-print the {ok,value|error} envelope and
 * set exit 1 on a domain failure (ok:false), else 0. Uses process.exitCode (not
 * process.exit) so a caller's `finally { browser.close() }` still runs.
 */
export function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result && result.ok === false ? 1 : 0;
}

/**
 * Headless chromium ships with WebGPU OFF by default: navigator.gpu exists but
 * requestAdapter() returns null, so the engine's createRenderer throws "no usable
 * backend", bootViewport aborts BEFORE mounting __forgeaxEval, and readiness waits
 * time out at 30s. These flags turn on a usable GPU backend (ANGLE-over-Metal on
 * macOS + unsafe/Vulkan WebGPU) so the editor actually boots headless. Kept here
 * (one place) so this hard-won knowledge is not re-lost. Only gateway-eval.mjs
 * (the headless driver) uses it today.
 */
export const GATEWAY_GPU_ARGS = [
  '--use-angle=metal',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan,WebGPU',
  '--ignore-gpu-blocklist',
];

/** GATEWAY_GPU_ARGS, or a space-separated FORGEAX_CHROMIUM_ARGS override (other
 *  platforms/GPUs). */
export function resolveGpuArgs() {
  return process.env.FORGEAX_CHROMIUM_ARGS
    ? process.env.FORGEAX_CHROMIUM_ARGS.split(/\s+/).filter(Boolean)
    : GATEWAY_GPU_ARGS;
}
