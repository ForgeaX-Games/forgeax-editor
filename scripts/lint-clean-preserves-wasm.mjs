#!/usr/bin/env node
// lint-clean-preserves-wasm.mjs — static gate: `bun fx clean`'s submodule scrub
// in scripts/fx.ts must PRESERVE the toolchain-gated engine wasm pkg dirs
// (packages/fbx/pkg, packages/wgpu-wasm/pkg).
//
// WHY THIS EXISTS (the defect it closes)
//   clean() deep-scrubs every submodule with `git clean -ffdx` so the
//   superproject reports a fully-clean status. That also wiped the gitignored
//   wasm binaries — including packages/fbx/pkg/fbx-wasm.{mjs,wasm}, which is
//   NOT freely regenerable: re-acquiring it needs the prebuilt GitHub release
//   (network + GH_TOKEN auth) or a local Emscripten toolchain (emcc). In
//   offline/restricted environments every `bun fx clean` → `bun fx setup`
//   sequence died at ensureFbxWasm(). The ignored pkg/ files never dirty the
//   superproject's submodule status, so excluding them from the scrub keeps
//   the clean-status guarantee intact while making clean→setup survivable.
//
//   CI never runs `fx clean`, so without this gate the exclusion could be
//   dropped in a refactor and the failure would only resurface on a developer
//   machine. This lint turns that drift into a red `bun run lint` (a required
//   check in the typecheck job).
//
// Usage:   node scripts/lint-clean-preserves-wasm.mjs [--file <path>]
//          (--file defaults to scripts/fx.ts; the self-test feeds synthetic copies)
// Exits    0 scrub preserves both wasm pkg dirs
//          · 1 exclusion missing or not wired into the scrub (regression)
//          · 2 anchor missing/renamed (refuse to pass blind — re-point the gate).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

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
  console.error(`[lint-clean-preserves-wasm] cannot read ${target}: ${e.message}`);
  process.exit(2);
}

const lines = source.split('\n');

// Anchor 1 — the submodule deep-scrub command inside clean(). Match the actual
// `git clean -ffdx` scrub string (tolerant of the dry-run -ffndx sibling), not
// prose comments: a comment-only match would let a code change pass blind.
const SCRUB = /git clean -ffn?dx\b/;
// Anchor 2 — the keep-list constant the scrub must interpolate.
const KEEP_CONST = /const keepWasm\s*=/;

const scrubIndex = lines.findIndex((l) => SCRUB.test(l) && !l.trimStart().startsWith('//'));
const keepIndex = lines.findIndex((l) => KEEP_CONST.test(l));

if (scrubIndex === -1) {
  console.error(`[lint-clean-preserves-wasm] anchor not found in ${target}: submodule scrub (git clean -ffdx).`);
  console.error('  clean() was refactored — re-point this gate to the new scrub rather than letting it pass blind.');
  process.exit(2);
}

const REQUIRED_EXCLUSIONS = ['packages/fbx/pkg/', 'packages/wgpu-wasm/pkg/'];

if (keepIndex === -1) {
  console.error(
    `[lint-clean-preserves-wasm] REGRESSION — submodule scrub (line ${scrubIndex + 1}) has no wasm keep-list in ${target}.`,
  );
  console.error(`  Expected exclusions: ${REQUIRED_EXCLUSIONS.join(', ')}.`);
  console.error('  Without them `fx clean` wipes the toolchain-gated wasm binaries and the next');
  console.error('  `fx setup` fails wherever the prebuilt fbx release / emcc is unavailable.');
  process.exit(1);
}

const keepLine = lines[keepIndex];
const missing = REQUIRED_EXCLUSIONS.filter((p) => !keepLine.includes(p));
// The keep-list must actually flow into the scrub command, not sit unused.
const wired = lines[scrubIndex].includes('${keepWasm}') || lines[scrubIndex].includes('keepWasm');

if (missing.length > 0 || !wired) {
  console.error(`[lint-clean-preserves-wasm] REGRESSION — wasm preservation broken in ${target}:`);
  if (missing.length > 0) console.error(`  keep-list (line ${keepIndex + 1}) drops: ${missing.join(', ')}`);
  if (!wired) console.error(`  scrub (line ${scrubIndex + 1}) does not interpolate the keep-list.`);
  console.error('  `fx clean` must not delete packages/fbx/pkg or packages/wgpu-wasm/pkg inside the engine submodule.');
  process.exit(1);
}

console.log(
  `[lint-clean-preserves-wasm] OK — submodule scrub (line ${scrubIndex + 1}) preserves ${REQUIRED_EXCLUSIONS.join(', ')}.`,
);
process.exit(0);
