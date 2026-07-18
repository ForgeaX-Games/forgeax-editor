#!/usr/bin/env node
// lint-wasm-before-dist.test.mjs — falsification self-test for the
// wasm-before-dist ordering gate. Proves the gate has discriminating power:
//   (a) correct order (wasm before dist)      → exit 0
//   (b) reversed order (dist before wasm)      → exit 1  (the historical bug)
//   (c) missing/renamed anchor                 → exit 2  (refuse to pass blind)
//   (d) the REAL scripts/fx.ts (no --file)     → exit 0  (installer stays correct)
//
// NOTE: colocated *.test.mjs are dev-time harnesses — they are NOT run in CI
// (nothing in ci.yml / package.json invokes scripts/*.test.mjs). CI enforcement
// is lint-wasm-before-dist.mjs via `bun run lint`. This file documents + proves
// the gate's behavior; run it manually: node scripts/lint-wasm-before-dist.test.mjs
//
// Exits: 0 all scenarios pass, 1 at least one failed.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LINT_SCRIPT = join(__dirname, 'lint-wasm-before-dist.mjs');

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

// Run the gate against an explicit file path.
function runLint(filePath) {
  const r = spawnSync(process.execPath, [LINT_SCRIPT, '--file', filePath], {
    encoding: 'utf8',
    timeout: 5000,
  });
  return r.status;
}

// Minimal synthetic install() bodies. The gate keys on two anchors:
//   - `ensureWasm(` call
//   - the `['-r', '--filter', './packages/*', 'build']` arg array
// so the fixtures only need those two lines in the right (or wrong) order.
const GOOD = `
function install() {
  sh('git', ['submodule', 'update', '--init', '--recursive']);
  sh('bun', ['install']);
  ensureWasm();
  ensureFbxWasm();
  sh('pnpm', ['-r', '--filter', './packages/*', 'build'], { cwd: ENGINE_DIR });
}
`;

const REVERSED = `
function install() {
  sh('git', ['submodule', 'update', '--init', '--recursive']);
  sh('bun', ['install']);
  sh('pnpm', ['-r', '--filter', './packages/*', 'build'], { cwd: ENGINE_DIR });
  ensureWasm();
  ensureFbxWasm();
}
`;

// Anchor renamed (ensureWasm → buildWgpuWasm): the gate must NOT silently pass.
const RENAMED_ANCHOR = `
function install() {
  buildWgpuWasm();
  sh('pnpm', ['-r', '--filter', './packages/*', 'build'], { cwd: ENGINE_DIR });
}
`;

// Definition at top (as in real fx.ts) but the CALL moved below the dist build.
// The gate must anchor on the call, not the definition, or this reversal passes.
const DEF_TOP_CALL_BELOW = `
function ensureWasm() {
  // build wgpu wasm — definition lives near the top of the file
}
function install() {
  sh('pnpm', ['-r', '--filter', './packages/*', 'build'], { cwd: ENGINE_DIR });
  ensureWasm();
}
`;

const tmpDir = mkdtempSync(join(tmpdir(), 'wasm-before-dist-test-'));
console.log('lint-wasm-before-dist.test.mjs — falsification self-test');
console.log(`Temp dir: ${tmpDir}\n`);

const goodPath = join(tmpDir, 'good-cli.mjs');
const reversedPath = join(tmpDir, 'reversed-cli.mjs');
const renamedPath = join(tmpDir, 'renamed-cli.mjs');
const defTopPath = join(tmpDir, 'def-top-call-below-cli.mjs');
writeFileSync(goodPath, GOOD);
writeFileSync(reversedPath, REVERSED);
writeFileSync(renamedPath, RENAMED_ANCHOR);
writeFileSync(defTopPath, DEF_TOP_CALL_BELOW);

console.log('Scenario (a): correct order (wasm before dist) — expect exit 0');
assertEqual('(a) good order → 0', runLint(goodPath), 0);

console.log('Scenario (b): reversed order (dist before wasm) — expect exit 1');
assertEqual('(b) reversed order → 1', runLint(reversedPath), 1);

console.log('Scenario (c): renamed/missing anchor — expect exit 2');
assertEqual('(c) missing anchor → 2', runLint(renamedPath), 2);

console.log('Scenario (e): definition at top, call moved below dist — expect exit 1');
assertEqual('(e) def-top + call-below → 1', runLint(defTopPath), 1);

console.log('Scenario (d): real scripts/fx.ts (default target) — expect exit 0');
{
  total++;
  const r = spawnSync(process.execPath, [LINT_SCRIPT], { encoding: 'utf8', timeout: 5000 });
  if (r.status === 0) {
    console.log('  PASS: (d) real fx.ts → 0');
  } else {
    failures++;
    console.error(`  FAIL: (d) real fx.ts → expected 0, got ${JSON.stringify(r.status)}\n${r.stderr}`);
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
