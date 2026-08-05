#!/usr/bin/env node
// lint-clean-preserves-wasm.test.mjs — falsification self-test for the
// clean-preserves-wasm gate. Proves the gate has discriminating power:
//   (a) scrub with all three exclusions wired → exit 0
//   (b) scrub without any keep-list           → exit 1  (the historical bug)
//   (c) keep-list present but not wired in    → exit 1
//   (d) keep-list dropping codec pkg          → exit 1  (the 2026-08-05 bug)
//   (e) scrub anchor renamed                  → exit 2  (refuse to pass blind)
//   (f) the REAL scripts/fx.ts (no --file)    → exit 0  (clean stays correct)
//
// NOTE: colocated *.test.mjs are dev-time harnesses — they are NOT run in CI
// (nothing in ci.yml / package.json invokes scripts/*.test.mjs). CI enforcement
// is lint-clean-preserves-wasm.mjs via `bun run lint`. This file documents +
// proves the gate's behavior; run it manually:
//   node scripts/lint-clean-preserves-wasm.test.mjs
//
// Exits: 0 all scenarios pass, 1 at least one failed.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LINT_SCRIPT = join(__dirname, 'lint-clean-preserves-wasm.mjs');

let failures = 0;
let total = 0;

function assertEqual(desc, actual, expected) {
  total++;
  if (actual === expected) {
    console.log(`  PASS: ${desc}`);
  } else {
    failures++;
    console.error(`  FAIL: ${desc} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function runLint(filePath) {
  const r = spawnSync(process.execPath, [LINT_SCRIPT, '--file', filePath], {
    encoding: 'utf8',
    timeout: 5000,
  });
  return r.status;
}

const GOOD = `
function clean(argv) {
  const keepWasm = "-e 'packages/fbx/pkg/' -e 'packages/wgpu-wasm/pkg/' -e 'packages/codec/pkg/'";
  const subScrub = dryRun
    ? \`git reset --hard -q && git clean -ffndx \${keepWasm}\`
    : \`git reset --hard -q && git clean -ffdx \${keepWasm}\`;
}
`;

// The historical bug: bare -ffdx scrub, no keep-list at all.
const NO_KEEPLIST = `
function clean(argv) {
  const subScrub = dryRun ? 'git reset --hard -q && git clean -ffndx' : 'git reset --hard -q && git clean -ffdx';
}
`;

// Keep-list defined but the scrub never interpolates it (dead constant).
const UNWIRED_KEEPLIST = `
function clean(argv) {
  const keepWasm = "-e 'packages/fbx/pkg/' -e 'packages/wgpu-wasm/pkg/' -e 'packages/codec/pkg/'";
  const subScrub = dryRun ? 'git reset --hard -q && git clean -ffndx' : 'git reset --hard -q && git clean -ffdx';
}
`;

// The 2026-08-05 bug: codec dropped from the keep-list — the scrub wipes
// packages/codec/pkg while preserving the other two wasm dirs.
const PARTIAL_KEEPLIST = `
function clean(argv) {
  const keepWasm = "-e 'packages/fbx/pkg/' -e 'packages/wgpu-wasm/pkg/'";
  const subScrub = \`git reset --hard -q && git clean -ffdx \${keepWasm}\`;
}
`;

// Scrub refactored to a different command shape: the gate must NOT pass blind.
const RENAMED_ANCHOR = `
function clean(argv) {
  const keepWasm = "-e 'packages/fbx/pkg/' -e 'packages/wgpu-wasm/pkg/' -e 'packages/codec/pkg/'";
  const subScrub = \`git reset --hard -q && git clean -ffd \${keepWasm}\`;
}
`;

const tmpDir = mkdtempSync(join(tmpdir(), 'clean-preserves-wasm-test-'));
console.log('lint-clean-preserves-wasm.test.mjs — falsification self-test');
console.log(`Temp dir: ${tmpDir}\n`);

const fixtures = {
  good: GOOD,
  noKeep: NO_KEEPLIST,
  unwired: UNWIRED_KEEPLIST,
  partial: PARTIAL_KEEPLIST,
  renamed: RENAMED_ANCHOR,
};
const paths = {};
for (const [name, body] of Object.entries(fixtures)) {
  paths[name] = join(tmpDir, `${name}-fx.ts`);
  writeFileSync(paths[name], body);
}

console.log('Scenario (a): scrub with all three exclusions wired — expect exit 0');
assertEqual('(a) good → 0', runLint(paths.good), 0);

console.log('Scenario (b): scrub without keep-list (historical bug) — expect exit 1');
assertEqual('(b) no keep-list → 1', runLint(paths.noKeep), 1);

console.log('Scenario (c): keep-list defined but not wired — expect exit 1');
assertEqual('(c) unwired keep-list → 1', runLint(paths.unwired), 1);

console.log('Scenario (d): keep-list missing codec pkg (2026-08-05 bug) — expect exit 1');
assertEqual('(d) partial keep-list → 1', runLint(paths.partial), 1);

console.log('Scenario (e): scrub anchor renamed — expect exit 2');
assertEqual('(e) renamed anchor → 2', runLint(paths.renamed), 2);

console.log('Scenario (f): real scripts/fx.ts (default target) — expect exit 0');
{
  total++;
  const r = spawnSync(process.execPath, [LINT_SCRIPT], { encoding: 'utf8', timeout: 5000 });
  if (r.status === 0) {
    console.log('  PASS: (f) real fx.ts → 0');
  } else {
    failures++;
    console.error(`  FAIL: (f) real fx.ts → expected 0, got ${JSON.stringify(r.status)}\n${r.stderr}`);
  }
}

rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${total - failures}/${total} passed`);
if (failures > 0) {
  console.error(`FAILURES: ${failures} scenario(s) failed`);
  process.exit(1);
}
console.log('All scenarios passed — gate has discriminating power');
process.exit(0);
