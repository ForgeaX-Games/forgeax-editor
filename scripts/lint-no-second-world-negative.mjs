#!/usr/bin/env node
// lint-no-second-world-negative.mjs — negative self-test for the no-second-world gate.
// feat-20260707-editor-world-fork-ssot-level-load-play-activeworld M4 w31.
//
// plan-strategy D-6 option (a) / requirements AC-12:
//   Prove the lint-no-second-world gate still detects violations after our comment-only
//   header correction (w29). The gate scans the engine submodule diff; injecting
//   `new World()` into an engine production file must trigger exit code 1.
//
// Test steps:
//   1. Inject a dummy `new World()` call into a production .ts file inside the
//      engine submodule and commit it (temp commit).
//   2. Run the gate — assert exit code 1 (gate intercepts the violation).
//   3. Revert the temp commit — restore engine submodule to clean state.
//   4. Run the gate again — assert exit code 0 (gate passes on clean state).
//
// The injected line is a no-op assignment `const ___NEGATIVE_TEST_DO_NOT_MERGE =
// new World();` — it compiles (World is importable from @forgeax/engine-ecs in
// the ecs package) but is clearly marked as test junk. We inject into
// packages/engine/packages/ecs/src/schedule.ts because:
//   (a) it is a production source file (not __tests__), so the gate's test-hunk
//       exclusion does NOT filter it;
//   (b) it imports from the ecs root barrel which re-exports World;
//   (c) the injection is at file end, minimal risk of merge-conflict with any
//       real parallel work on the engine pin.
//
// Usage: bun scripts/lint-no-second-world-negative.mjs
// Exits 0 on pass (negative test correctly blocks + clean state passes).
// Exits 1 on failure (gate missed the injection, or clean state spuriously
// fails).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const ENGINE = resolve(REPO, 'packages', 'engine');
const GATE_SCRIPT = resolve(__dirname, 'lint-no-second-world.mjs');
const TARGET_FILE = resolve(
  ENGINE,
  'packages',
  'ecs',
  'src',
  'schedule.ts',
);

const INJECTION_LINE =
  'const ___NEGATIVE_TEST_DO_NOT_MERGE = new World(); // lint gate negative self-test';

function git(cmdArgs) {
  return execFileSync('git', cmdArgs, { encoding: 'utf8', cwd: ENGINE }).trim();
}

function run(...args) {
  return execFileSync(args[0], args.slice(1), {
    encoding: 'utf8',
    cwd: REPO,
  }).trim();
}

function runMaybe(args) {
  try {
    return run(args);
  } catch {
    return null;
  }
}

function runGate() {
  try {
    run(process.execPath, GATE_SCRIPT);
    return 0; // gate passed
  } catch (e) {
    // execFileSync throws with .status (exit code) and .stderr (child stderr)
    const exitCode = e.status ?? e.exitCode ?? e.code;
    if (exitCode === 1) return 1; // gate blocked (expected on violation)
    console.error(`Gate exited with unexpected code ${exitCode}: ${e.stderr || e.message}`);
    return 999;
  }
}

// ── Step 0: safety precheck ──────────────────────────────────────────────
if (!existsSync(TARGET_FILE)) {
  console.error(`Target file not found: ${TARGET_FILE}`);
  process.exit(2);
}

// The engine must be in a clean workspace state.
const engineStatus = git(['status', '--porcelain']);
if (engineStatus.trim() !== '') {
  console.error(
    'Engine submodule has uncommitted changes. Refusing to run — reset first.',
  );
  console.error(engineStatus);
  process.exit(2);
}

// Record the initial engine HEAD so we can revert cleanly.
const initialHead = git(['rev-parse', 'HEAD']);
console.log(`[negative-test] Engine initial HEAD: ${initialHead.slice(0, 7)}`);

// ── Step 1: baseline — gate must pass on clean engine ─────────────────────
console.log('[negative-test] Step 1: baseline gate on clean engine...');
const baselineCode = runGate();
if (baselineCode !== 0) {
  console.error(
    `[negative-test] FAIL: gate exited ${baselineCode} on clean engine — expected 0.`,
  );
  process.exit(1);
}
console.log('[negative-test] Step 1 PASS: gate passes on clean engine (exit 0).');

// ── Step 2: inject `new World()` into engine production file ───────────────
console.log('[negative-test] Step 2: injecting new World() into engine source...');
const originalContent = readFileSync(TARGET_FILE, 'utf8');
const injectedContent = originalContent + '\n' + INJECTION_LINE + '\n';
writeFileSync(TARGET_FILE, injectedContent, 'utf8');

git(['add', TARGET_FILE]);
git([
  'commit',
  '-m',
  'test: negative self-test — inject new World() (do not merge)',
]);
const injectedHead = git(['rev-parse', 'HEAD']);
console.log(
  `[negative-test] Injected commit: ${injectedHead.slice(0, 7)}`,
);

// ── Step 3: gate must BLOCK (exit 1) on the injected `new World()` ────────
console.log('[negative-test] Step 3: gate must intercept the injected new World()...');
const blockCode = runGate();
if (blockCode !== 1) {
  console.error(
    `[negative-test] FAIL: gate exited ${blockCode} on injected diff — expected 1 (BLOCKED).`,
  );
  console.error(
    'The gate did not detect the injected new World() call — it may have been weakened.',
  );
  // Attempt cleanup before exiting.
  git(['reset', '--hard', initialHead]);
  process.exit(1);
}
console.log('[negative-test] Step 3 PASS: gate blocked the injected new World() (exit 1).');

// ── Step 4: revert the temp commit — restore engine to clean state ─────────
console.log('[negative-test] Step 4: reverting temp commit...');
git(['reset', '--hard', initialHead]);
const restoredHead = git(['rev-parse', 'HEAD']);
if (restoredHead !== initialHead) {
  console.error(
    `[negative-test] FAIL: engine HEAD ${restoredHead.slice(0, 7)} != initial ${initialHead.slice(0, 7)} after reset.`,
  );
  process.exit(1);
}
console.log('[negative-test] Engine restored to clean state.');

// ── Step 5: post-revert — gate must pass again ────────────────────────────
console.log('[negative-test] Step 5: gate must pass on restored clean state...');
const postRevertCode = runGate();
if (postRevertCode !== 0) {
  console.error(
    `[negative-test] FAIL: gate exited ${postRevertCode} on restored clean engine — expected 0.`,
  );
  process.exit(1);
}
console.log('[negative-test] Step 5 PASS: gate passes on clean engine after revert.');

console.log(
  '[negative-test] ALL STEPS PASS — gate intercept for engine-side new World() confirmed.',
);