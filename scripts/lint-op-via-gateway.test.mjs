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
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
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

function runLint(diffPath, extraArgs = []) {
  if (!existsSync(LINT_SCRIPT)) {
    // TDD red-phase: script not written yet
    return { status: null, stdout: '', stderr: 'lint-op-via-gateway.mjs not found (TDD: implement m5-w3 first)' };
  }
  const result = spawnSync(process.execPath, [LINT_SCRIPT, '--diff-file', diffPath, ...extraArgs], {
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
  // A real store op named create* whose FIRST param is not `deps` must STILL be
  // flagged -- the DI_FACTORY_RE exemption (feat-20260709 M2) is scoped to the
  // `deps` first-parameter signature so it never widens the hole to real ops like
  // createSceneFile(id, duplicateCurrent).
  {
    file: 'packages/core/src/store/persistence/scene-list.ts',
    lines: [
      "export function createLevelDirectly(id: string, dup: boolean): void {",
      "  writeToDisk(id, dup);",
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
  // scene-persistence.ts: create*Context DI-context factory (feat-20260709 M1 /
  // plan-strategy D-2 + §8). Returns a fresh state carrier, dispatches nothing,
  // mutates no global -> not a gateway-bypassing op (CONTEXT_FACTORY_RE exempt).
  {
    file: 'packages/core/src/store/scene-persistence.ts',
    lines: [
      "export function createScenePersistenceContext(): ScenePersistenceContext {",
      "  return { currentSceneId: 'default', isDirty: false };",
      "}",
    ],
  },
  // persistence/disk-io.ts: create<Thing>(deps: <Thing>Deps) DI factory
  // (feat-20260709 M2 / plan-strategy D-3 + §8). The whole dependency edge is the
  // injected `deps`; the factory dispatches nothing and mutates no global -> not a
  // gateway-bypassing op (DI_FACTORY_RE exempt).
  {
    file: 'packages/core/src/store/persistence/disk-io.ts',
    lines: [
      "export function createDiskIo(deps: DiskIoDeps): DiskIo {",
      "  return { doSaveDocToDisk, doLoadDocFromDisk };",
      "}",
    ],
  },
  // persistence/scene-list.ts: another DI factory taking `deps` (same exemption).
  {
    file: 'packages/core/src/store/persistence/scene-list.ts',
    lines: [
      "export function createSceneList(deps: SceneListDeps): SceneList {",
      "  return { initSceneList, doSwitchSceneFile };",
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
    file: 'packages/edit-runtime/src/viewport/test-helper.test.ts',
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
// Scenario (g): NAME-REUSE HOLE CLOSED -- a setter reusing a baselined NAME in a
// DIFFERENT file is no longer auto-exempt (path-qualified baseline). We seed the
// baseline identity `store/selection.ts:setSelected` and add a NEW setSelected in
// a DIFFERENT file (store/hover.ts). Bare-name keying would have exempted it;
// path-qualified keying must FLAG it → exit 1. We also confirm the SAME identity
// (same file) IS still exempt.
// ---------------------------------------------------------------------------
console.log('Scenario (g): NAME-REUSE -- baselined name reused in a different file → exit 1');
{
  const reuseHunks = [{
    file: 'packages/core/src/store/hover.ts',
    lines: [
      'export function setSelected(id: number): void {',
      '  hovered = id;',
      '}',
    ],
  }];
  const reusePath = join(diffDir, 'name-reuse.diff');
  writeFileSync(reusePath, makeDiff(reuseHunks));
  // Baseline grandfathers setSelected ONLY in selection.ts.
  const r = runLint(reusePath, ['--baseline-identities', 'packages/core/src/store/selection.ts:setSelected']);
  assertEqual('(g) same-name-different-file setter is flagged', r.status, 1);
}
console.log('Scenario (g2): SAME identity (same file) still exempt → exit 0');
{
  const sameHunks = [{
    file: 'packages/core/src/store/selection.ts',
    lines: [
      'export function setSelected(id: number): void {',
      '  selected = id;',
      '}',
    ],
  }];
  const samePath = join(diffDir, 'same-identity.diff');
  writeFileSync(samePath, makeDiff(sameHunks));
  const r = runLint(samePath, ['--baseline-identities', 'packages/core/src/store/selection.ts:setSelected']);
  assertEqual('(g2) same file+name identity stays exempt', r.status, 0);
}

// ---------------------------------------------------------------------------
// RATCHET scenarios (shrinking baseline, full-tree). Point the gate at a scratch
// baseline JSON + synthetic scan tree. The diff is CLEAN so only the full-tree
// ratchet decides the exit code.
// ---------------------------------------------------------------------------
const cleanRatchetDiff = join(diffDir, 'ratchet-clean.diff');
writeFileSync(cleanRatchetDiff, makeDiff([{
  file: 'packages/core/src/io/catalog.ts',
  lines: ['  // no store changes'],
}]));

function makeStoreTree(setters) {
  const root = mkdtempSync(join(tmpDir, 'scan-'));
  for (const { file, fnNames } of setters) {
    const abs = join(root, 'packages/core/src/store', file);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, fnNames.map(n => `export function ${n}(): void {}`).join('\n'));
  }
  return root;
}
function writeBaseline(obj) {
  const p = join(tmpDir, `baseline-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
  return p;
}
function runRatchet(baselineFile, scanRoot) {
  const r = spawnSync(process.execPath, [
    LINT_SCRIPT, '--diff-file', cleanRatchetDiff,
    '--baseline-file', baselineFile, '--scan-root', scanRoot,
  ], { encoding: 'utf8', timeout: 5000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// (h) RATCHET FAIL: full-tree population (2) EXCEEDS baseline (1) → exit 1
console.log('Scenario (h): RATCHET FAIL -- full-tree setters > baseline → exit 1');
{
  const scanRoot = makeStoreTree([{ file: 'a.ts', fnNames: ['setFoo', 'saveBar'] }]);
  const bl = writeBaseline({ rawWriteCount: 0, gatewayBaselineSetters: ['packages/core/src/store/a.ts:setFoo'] });
  assertEqual('(h) exit 1', runRatchet(bl, scanRoot).status, 1);
}

// (i) RATCHET DOWN: full-tree population (1) BELOW baseline (3) → exit 0 + rewrite
console.log('Scenario (i): RATCHET DOWN -- full-tree setters < baseline → exit 0 + baseline rewritten lower');
{
  const scanRoot = makeStoreTree([{ file: 'a.ts', fnNames: ['setFoo'] }]);
  const bl = writeBaseline({ rawWriteCount: 0, gatewayBaselineSetters: [
    'packages/core/src/store/a.ts:setFoo',
    'packages/core/src/store/a.ts:setGone',
    'packages/core/src/store/b.ts:saveGone',
  ] });
  const r = runRatchet(bl, scanRoot);
  assertEqual('(i) exit 0', r.status, 0);
  assertEqual('(i) baseline rewritten to [a.ts:setFoo]', JSON.stringify(JSON.parse(readFileSync(bl, 'utf8')).gatewayBaselineSetters), JSON.stringify(['packages/core/src/store/a.ts:setFoo']));
}

// (j) RATCHET EQUAL: full-tree population (1) == baseline (1) → exit 0, unchanged
console.log('Scenario (j): RATCHET EQUAL -- full-tree setters == baseline → exit 0, unchanged');
{
  const scanRoot = makeStoreTree([{ file: 'a.ts', fnNames: ['setFoo'] }]);
  const bl = writeBaseline({ rawWriteCount: 0, gatewayBaselineSetters: ['packages/core/src/store/a.ts:setFoo'] });
  const r = runRatchet(bl, scanRoot);
  assertEqual('(j) exit 0', r.status, 0);
  assertEqual('(j) baseline unchanged', JSON.stringify(JSON.parse(readFileSync(bl, 'utf8')).gatewayBaselineSetters), JSON.stringify(['packages/core/src/store/a.ts:setFoo']));
}

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