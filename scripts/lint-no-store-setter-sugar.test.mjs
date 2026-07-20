#!/usr/bin/env node
// lint-no-store-setter-sugar.test.mjs -- setter-sugar gate falsification self-test
// (feat-20260707-editor-trace-ioc M3 t15, plan-strategy §5.1, requirements AC-23).
//
// Scenarios:
//   (a) VIOLATION -- new store export whose body is just gateway.dispatch → exit 1
//   (b) COMPLIANT -- read-side pub/sub export (on*Change) → exit 0
//   (c) COMPLIANT -- export with real logic beyond a lone dispatch → exit 0
//   (d) TEST-HUNK -- setter sugar in *.test.ts → exit 0
//   (e) NON-STORE -- setter sugar outside store/ (e.g. io/) → exit 0
//   (f) CLEAN -- no new exports → exit 0
//
// Usage: node scripts/lint-no-store-setter-sugar.test.mjs

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LINT_SCRIPT = join(__dirname, 'lint-no-store-setter-sugar.mjs');

let failures = 0;
let total = 0;
function assertEqual(desc, actual, expected) {
  total++;
  if (actual !== expected) {
    failures++;
    console.error(`  FAIL: ${desc} -- expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`  PASS: ${desc}`);
  }
}

function makeDiff(hunks) {
  const parts = [];
  for (const h of hunks) {
    parts.push(`diff --git a/${h.file} b/${h.file}`);
    parts.push('index 0000000..0000000 100644');
    parts.push(`--- a/${h.file}`);
    parts.push(`+++ b/${h.file}`);
    parts.push(`@@ -1,0 +1,${h.lines.length} @@`);
    for (const line of h.lines) parts.push(`+${line}`);
  }
  return parts.join('\n');
}

function runLint(diffPath) {
  if (!existsSync(LINT_SCRIPT)) return { status: null };
  const r = spawnSync(process.execPath, [LINT_SCRIPT, '--diff-file', diffPath], { encoding: 'utf8', timeout: 5000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const tmpDir = mkdtempSync(join(tmpdir(), 'setter-sugar-test-'));
const diffDir = join(tmpDir, 'diffs');
mkdirSync(diffDir, { recursive: true });
const write = (name, hunks) => { const p = join(diffDir, name); writeFileSync(p, makeDiff(hunks)); return p; };

console.log('lint-no-store-setter-sugar.test.mjs -- setter-sugar gate TDD\n');

// (a) VIOLATION
console.log('Scenario (a): VIOLATION -- store export body is lone gateway.dispatch → exit 1');
assertEqual('(a) exit 1', runLint(write('viol.diff', [{
  file: 'packages/core/src/store/selection.ts',
  lines: [
    'export function setSelection(id: EntityId | null): void {',
    "  gateway.dispatch({ kind: 'setSelection', id });",
    '}',
  ],
}])).status, 1);

// (b) COMPLIANT read-side
console.log('Scenario (b): COMPLIANT -- read-side on*Change export → exit 0');
assertEqual('(b) exit 0', runLint(write('read.diff', [{
  file: 'packages/core/src/store/selection.ts',
  lines: [
    'export function onSelectionChange(fn: () => void): () => void {',
    '  selectionListeners.add(fn);',
    '  return () => selectionListeners.delete(fn);',
    '}',
  ],
}])).status, 0);

// (c) COMPLIANT real logic (dispatch is not the whole body)
console.log('Scenario (c): COMPLIANT -- export with logic beyond a lone dispatch → exit 0');
assertEqual('(c) exit 0', runLint(write('logic.diff', [{
  file: 'packages/core/src/store/selection.ts',
  lines: [
    'export function selectAndLog(id: number): void {',
    '  console.log("selecting", id);',
    "  gateway.dispatch({ kind: 'setSelection', id });",
    '}',
  ],
}])).status, 0);

// (d) TEST-HUNK
console.log('Scenario (d): TEST-HUNK -- setter sugar in *.test.ts → exit 0');
assertEqual('(d) exit 0', runLint(write('test.diff', [{
  file: 'packages/core/src/store/selection.test.ts',
  lines: [
    'export function setSelection(id: number): void {',
    "  gateway.dispatch({ kind: 'setSelection', id });",
    '}',
  ],
}])).status, 0);

// (e) NON-STORE path
console.log('Scenario (e): NON-STORE -- setter sugar outside store/ → exit 0');
assertEqual('(e) exit 0', runLint(write('nonstore.diff', [{
  file: 'packages/core/src/io/catalog.ts',
  lines: [
    'export function doThing(x: number): void {',
    "  gateway.dispatch({ kind: 'doThing', x });",
    '}',
  ],
}])).status, 0);

// (f) CLEAN
console.log('Scenario (f): CLEAN -- no new exports → exit 0');
assertEqual('(f) exit 0', runLint(write('clean.diff', [{
  file: 'packages/core/src/store/selection.ts',
  lines: ['  // just a comment', '  const x = 1;'],
}])).status, 0);

rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${total - failures}/${total} passed`);
if (failures > 0) { console.error(`FAILURES: ${failures}`); process.exit(1); }
console.log('All falsification scenarios passed -- setter-sugar gate has discriminating power');
process.exit(0);
