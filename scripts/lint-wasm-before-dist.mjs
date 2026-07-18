#!/usr/bin/env node
// lint-wasm-before-dist.mjs — static gate: wgpu wasm must be built BEFORE the
// engine library dist in scripts/fx.ts `install()` (i.e. `bun fx setup`).
//
// WHY THIS EXISTS (the SSOT defect it closes — architecture-principles.md §1/§2)
//   The engine `app` package's tsup build inlines
//   packages/engine/packages/wgpu-wasm/dist/index.mjs, which `import`s
//   ../pkg/wgpu_wasm.js. That pkg/ dir is gitignored and only produced by the
//   wgpu wasm build (ensureWasm()). If the engine dist is built BEFORE wasm, on a
//   fresh clone esbuild cannot resolve ../pkg/wgpu_wasm.js and `pnpm -r build`
//   aborts — `bun run setup` breaks.
//
//   The ordering fact "wasm precedes engine dist" lived as TWO independent copies:
//     1. .github/workflows/ci.yml — replays the build in YAML (build.sh → pnpm -r
//        build). CI ACTUALLY RUNS this, so a wrong order fails the job: self-gated.
//     2. scripts/fx.ts install() — the same order in TS. CI never runs setup, so
//        this copy was UNGATED and silently drifted (dist-before-wasm) undetected.
//   This lint restores symmetry: it statically gates copy #2 so a reorder turns
//   `bun run lint` (a required check in the typecheck job) red.
//
// SCOPE — wgpu only, NOT fbx. CI does not build fbx (emcc is local-only) and the
//   inlining dependency that broke was wgpu's ../pkg/wgpu_wasm.js. We anchor on
//   ensureWasm(), not ensureFbxWasm().
//
// Usage:   node scripts/lint-wasm-before-dist.mjs [--file <path>]
//          (--file defaults to scripts/fx.ts; the self-test feeds synthetic copies)
// Exits    0 wasm-before-dist (correct) · 1 dist-before-wasm (regression)
//          · 2 anchor missing/renamed (refuse to pass blind — re-point the gate).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// --file <path> override (default: scripts/fx.ts). Lets the self-test point the
// gate at synthetic copies without touching the real installer.
function parseFileArg(argv) {
  const i = argv.indexOf('--file');
  if (i !== -1 && argv[i + 1]) return resolve(argv[i + 1]);
  return resolve(REPO_ROOT, 'scripts', 'fx.ts');
}

const target = parseFileArg(process.argv.slice(2));

let source;
try {
  source = readFileSync(target, 'utf8');
} catch (e) {
  console.error(`[lint-wasm-before-dist] cannot read ${target}: ${e.message}`);
  process.exit(2);
}

const lines = source.split('\n');

// Anchor 1 — the wgpu wasm build trigger. Match the CALL statement (line-start,
// optional `await`), NOT the `function ensureWasm()` definition (has a `function `
// prefix) nor a `// ensureWasm()` comment (has a `//` prefix) — otherwise the
// gate would lock onto the top-of-file definition and a moved call could pass.
const ENSURE_WASM = /^\s*(?:await\s+)?ensureWasm\s*\(\s*\)/;
// Anchor 2 — the shared engine-dist build command. Whitespace/quote-tolerant so a
// reformat doesn't blind the gate: matches ['-r', '--filter', './packages/*', 'build'].
const DIST_BUILD =
  /\[\s*['"]-r['"]\s*,\s*['"]--filter['"]\s*,\s*['"]\.\/packages\/\*['"]\s*,\s*['"]build['"]/;

const ensureWasmIndex = lines.findIndex((l) => ENSURE_WASM.test(l));
const distBuildIndex = lines.findIndex((l) => DIST_BUILD.test(l));

if (ensureWasmIndex === -1 || distBuildIndex === -1) {
  const missing = [];
  if (ensureWasmIndex === -1) missing.push('ensureWasm() call');
  if (distBuildIndex === -1) missing.push("engine dist build (['-r','--filter','./packages/*','build'])");
  console.error(
    `[lint-wasm-before-dist] anchor(s) not found in ${target}: ${missing.join(', ')}.`,
  );
  console.error(
    '  The installer was refactored — re-point this gate to the new call sites rather than letting it pass blind.',
  );
  process.exit(2);
}

if (ensureWasmIndex >= distBuildIndex) {
  console.error(
    `[lint-wasm-before-dist] REGRESSION — engine dist build (line ${distBuildIndex + 1}) runs BEFORE ensureWasm() (line ${ensureWasmIndex + 1}) in ${target}.`,
  );
  console.error(
    '  The engine `app` tsup build inlines wgpu-wasm/dist/index.mjs → ../pkg/wgpu_wasm.js;',
  );
  console.error(
    '  on a fresh clone pkg/ does not exist yet, so `pnpm -r build` fails. Build wasm first.',
  );
  process.exit(1);
}

console.log(
  `[lint-wasm-before-dist] OK — ensureWasm() (line ${ensureWasmIndex + 1}) precedes engine dist build (line ${distBuildIndex + 1}).`,
);
process.exit(0);
