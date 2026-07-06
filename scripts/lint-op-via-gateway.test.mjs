#!/usr/bin/env node
// lint-op-via-gateway.test.mjs -- M5 gate B falsification self-test
// (feat-20260706-editor-op-gateway-single-entry-b-catalog-defineop, m5-w1).
//
// TDD: written BEFORE lint-op-via-gateway.mjs exists, per plan-strategy 5.1.
// Four scenarios validate the gate has discriminating power:
//   (a) VIOLATION diff (new setter in store/ not via gateway) → lint exit 1
//   (b) COMPLIANT diff (new code using gateway.dispatch) → lint exit 0
//   (c) EXEMPTION diff (new setter in ref-request.ts / mesh-stats.ts /
//       assets-changed.ts / disk-watch.ts / init*/bootstrap functions) → exit 0
//   (d) TEST-HUNK diff (new setter in __tests__/ or *.test.*) → lint exit 0
//
// Each scenario creates a synthetic git-diff file and runs the lint script
// with --diff-file, then asserts the exit code matches expectations.
//
// Usage: node scripts/lint-op-via-gateway.test.mjs
// Exits: 0 all pass, 1 at least one scenario failed

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LINT_SCRIPT = join(__dirname, 'lint-op-via-gateway.mjs');

let failures = 0;
let total = 0;

function assert(desc, fn) {
  total++;
  try {
    fn();
    console.log(`  PASS: ${desc}`);
    return true;
  } catch (e) {
    failures++;
    console.error(`  FAIL: ${desc} -- ${e.message}`);
    return false;
  }
}

function assertEqual(desc, actual, expected) {
  assert(desc, () => {
    if (actual !== expected) {
      throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  });
}

function makeDiff(hunks) {
  // hunks: array of { file, lines } -- lines are raw diff lines
  const parts = [];
  for (const h of hunks) {
    parts.push(`diff --git a/${h.file} b/${h.file}`);
    if (h.newFile) {
      parts.push('new file mode 100644');
      parts.push('index 0000000..0000000');
      parts.push(`--- /dev/null`);
    } else {
      parts.push(`index 0000000..0000000 100644`);
      parts.push(`--- a/${h.file}`);
    }
    parts.push(`+++ b/${h.file}`);
    if (h.newFile) {
      parts.push(`@@ -0,0 +1,${h.lines.length} @@`);
    } else {
      parts.push(`@@ -1,0 +1,${h.lines.length} @@`);
    }
    for (const line of h.lines) {
      parts.push(`+${line}`);
    }
  }
  return parts.join('\n');
}

function runLint(diffPath) {
  if (!existsSync(LINT_SCRIPT)) {
    // TDD red-phase: script not written yet
    return { status: null, stdout: '', stderr: 'lint-op-via-gateway.mjs not found (TDD: implement m5-w3 first)' };
  }
  const result = spawnSync(process.execPath, [LINT_SCRIPT, '--diff-file', diffPath], {
    encoding: 'utf8',
    timeout: 5000,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

// ---------------------------------------------------------------------------
// Setup: temporary directory for diff files
// ---------------------------------------------------------------------------
const tmpDir = mkdtempSync(join(tmpdir(), 'gate-b-test-'));
const diffDir = join(tmpDir, 'diffs');
mkdirSync(diffDir, { recursive: true });

console.log('lint-op-via-gateway.test.mjs -- M5 gate B falsification TDD');
console.log(`Temp dir: ${tmpDir}\n`);

// ---------------------------------------------------------------------------
// Scenario (a): VIOLATION -- new setter in non-exempt store file → exit 1
// ---------------------------------------------------------------------------
console.log('Scenario (a): VIOLATION diff -- expect exit 1 (non-zero)');

const violHunks = [
  // New export function setFoo in a store file not in exemption list
  {
    file: 'packages/core/src/store/selection.ts',
    lines: [
      "export function setFoo(entityId: number): void {",
      "  currentSelection = entityId;",
      "  emit();",
      "}",
    ],
  },
  // New export function saveSomething in scene-persistence.ts (not exempt)
  {
    file: 'packages/core/src/store/scene-persistence.ts',
    lines: [
      "export function saveSomething(): void {",
      "  // new save mutation without gateway",
      "  localStorage.setItem('foo', 'bar');",
      "}",
    ],
  },
];
const violDiffPath = join(diffDir, 'violation.diff');
writeFileSync(violDiffPath, makeDiff(violHunks));
const violResult = runLint(violDiffPath);

assertEqual(
  '(a) violation diff exit code must be non-zero (1)',
  violResult.status,
  1
);
if (violResult.status === 1 && violResult.stderr) {
  // Verify the error message mentions the violation
  assert('(a) violation stderr mentions offending file', () => {
    if (!violResult.stderr.includes('selection.ts') && !violResult.stderr.includes('setFoo')) {
      throw new Error(`stderr should mention the violation; got: ${violResult.stderr.slice(0, 200)}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Scenario (b): COMPLIANT -- op via gateway, no new bare setter → exit 0
// ---------------------------------------------------------------------------
console.log('Scenario (b): COMPLIANT diff -- expect exit 0');

const compHunks = [
  // New code that uses gateway.dispatch -- NOT a bare setter
  {
    file: 'packages/core/src/store/selection.ts',
    lines: [
      "// New helper that dispatches through gateway (compliant)",
      "export function selectAndFocus(id: number): void {",
      "  gateway.dispatch({ kind: 'setSelection', entities: [id] });",
      "}",
    ],
  },
  // Modify an existing applier (inside gateway machinery, not a bare setter)
  {
    file: 'packages/core/src/io/appliers.ts',
    lines: [
      "  // Register new session op via seam (compliant)",
      "  registerSessionApplier('alignToGrid', (op) => {",
      "    alignEntities(op.args.step);",
      "    return { ok: true };",
      "  });",
    ],
  },
];
const compDiffPath = join(diffDir, 'compliant.diff');
writeFileSync(compDiffPath, makeDiff(compHunks));
const compResult = runLint(compDiffPath);

assertEqual(
  '(b) compliant diff exit code must be 0',
  compResult.status,
  0
);

// ---------------------------------------------------------------------------
// Scenario (c): EXEMPTION -- new export in exemption list → exit 0
// ---------------------------------------------------------------------------
console.log('Scenario (c): EXEMPTION diff -- expect exit 0');

const exemptHunks = [
  // ref-request.ts: VAG postMessage, not local state change (D-5 exemption)
  {
    file: 'packages/core/src/store/ref-request.ts',
    lines: [
      "export function requestNewThing(): void {",
      "  window.parent.postMessage({ type: 'new-thing' }, '*');",
      "}",
    ],
  },
  // assets-changed.ts: broadcast signal (D-5 exemption)
  {
    file: 'packages/core/src/store/assets-changed.ts',
    lines: [
      "export function broadcastSomethingChanged(): void {",
      "  listeners.forEach(fn => fn());",
      "}",
    ],
  },
  // disk-watch.ts: infrastructure init (D-5 exemption)
  {
    file: 'packages/core/src/store/disk-watch.ts',
    lines: [
      "export function initExtraWatcher(): () => void {",
      "  const w = fs.watch('/extra', () => broadcastAssetsChanged());",
      "  return () => w.close();",
      "}",
    ],
  },
  // mesh-stats.ts: derived stats broadcast (D-5 exemption)
  {
    file: 'packages/core/src/store/mesh-stats.ts',
    lines: [
      "export function publishExtraStats(stats: unknown): void {",
      "  extraStats = stats;",
      "  emit();",
      "}",
    ],
  },
];
const exemptDiffPath = join(diffDir, 'exemption.diff');
writeFileSync(exemptDiffPath, makeDiff(exemptHunks));
const exemptResult = runLint(exemptDiffPath);

assertEqual(
  '(c) exemption diff exit code must be 0',
  exemptResult.status,
  0
);

// ---------------------------------------------------------------------------
// Scenario (d): TEST-HUNK -- setter in test file → exit 0 (exempt)
// ---------------------------------------------------------------------------
console.log('Scenario (d): TEST-HUNK diff -- expect exit 0');

const testHunks = [
  // New setter in __tests__/ directory -- should be exempt per TEST_HUNK pattern
  {
    file: 'packages/core/src/__tests__/fake-setter.test.ts',
    lines: [
      "export function setFakeValue(v: number): void {",
      "  fakeValue = v;",
      "}",
    ],
  },
  // New setter in a *.test.ts file -- should be exempt
  {
    file: 'packages/edit-runtime/src/engine/test-helper.test.ts',
    lines: [
      "export function setTestConfig(): void {",
      "  testConfig = { foo: 'bar' };",
      "}",
    ],
  },
];
const testDiffPath = join(diffDir, 'test-hunk.diff');
writeFileSync(testDiffPath, makeDiff(testHunks));
const testHunkResult = runLint(testDiffPath);

assertEqual(
  '(d) test-hunk diff exit code must be 0',
  testHunkResult.status,
  0
);

// ---------------------------------------------------------------------------
// Scenario (e): BONUS -- combined mix: violation + compliant → exit 1
// ---------------------------------------------------------------------------
console.log('Scenario (e): MIXED diff (violation + compliant) -- expect exit 1');

const mixedHunks = [
  // Compliant addition
  {
    file: 'packages/core/src/io/appliers.ts',
    lines: [
      "  registerSessionApplier('newOp', (op) => ({ ok: true }));",
    ],
  },
  // Violation addition (in same run)
  {
    file: 'packages/core/src/store/hover.ts',
    lines: [
      "export function setNewBadThing(v: string): void {",
      "  badThing = v;",
      "}",
    ],
  },
];
const mixedDiffPath = join(diffDir, 'mixed.diff');
writeFileSync(mixedDiffPath, makeDiff(mixedHunks));
const mixedResult = runLint(mixedDiffPath);

assertEqual(
  '(e) mixed diff exit code must be 1 (violation should be caught even alongside compliant code)',
  mixedResult.status,
  1
);

// ---------------------------------------------------------------------------
// Scenario (f): CLEAN -- no store changes at all → exit 0
// ---------------------------------------------------------------------------
console.log('Scenario (f): CLEAN diff (no store changes) -- expect exit 0');

const cleanHunks = [
  // Change in a non-store file
  {
    file: 'packages/core/src/io/catalog.ts',
    lines: [
      "  // Add a comment to catalog (no store changes)",
      "  // This file is in io/, not store/",
    ],
  },
  // Change in UI package
  {
    file: 'packages/panels/src/Inspector.tsx',
    lines: [
      "  // Update help text in inspector",
    ],
  },
];
const cleanDiffPath = join(diffDir, 'clean.diff');
writeFileSync(cleanDiffPath, makeDiff(cleanHunks));
const cleanResult = runLint(cleanDiffPath);

assertEqual(
  '(f) clean diff exit code must be 0',
  cleanResult.status,
  0
);

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
rmSync(tmpDir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${total - failures}/${total} passed`);
if (failures > 0) {
  console.error(`FAILURES: ${failures} scenarios failed`);
  process.exit(1);
}
console.log('All falsification scenarios passed -- gate B has discriminating power');
process.exit(0);