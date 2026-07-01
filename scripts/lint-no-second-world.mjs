#!/usr/bin/env node
// lint-no-second-world.mjs — AC-17 diff-scoped "no second world" gate
// (feat-20260630-viewport-2x2-run-x-display-redesign, w28).
//
// AC-17 forbids the feature from building a SECOND engine world. The single
// edit-runtime world (built once via the engine's createApp) hosts both editor
// and game systems (requirements C-1). This gate asserts the feature DIFF adds
// no net-new `new World()` / `createWorld()` in production engine source.
//
// WHY DIFF-SCOPED, NOT ABSOLUTE
//   editor-core/open-project.ts already constructs a `new World()` on origin/main
//   (an M3 proof-of-life sidecar). An absolute `count == 0` would be a stale
//   literal that trips on pre-existing code. We count only lines ADDED by this
//   feature, so pre-existing worlds don't false-positive and a newly introduced
//   one does.
//
// SHALLOW-CLONE RESILIENCE
//   The nested engine submodule is often a shallow clone with no fetched common
//   ancestor, so `git merge-base HEAD origin/main` returns non-zero. We fall back
//   to the feature-commit range `origin/main..HEAD` (commits reachable from HEAD
//   but not origin/main = this branch's work). Test fixtures are excluded — unit
//   tests legitimately spin up throwaway worlds.
//
// Usage:   node packages/editor/scripts/lint-no-second-world.mjs [enginePath]
// Exits    0 clean · 1 net-new world found · 2 cannot determine base (loud).

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Default: the nested engine submodule under the editor package.
const ENGINE = resolve(process.argv[2] ?? resolve(__dirname, '..', 'packages', 'engine'));

function git(args) {
  return execFileSync('git', ['-C', ENGINE, ...args], { encoding: 'utf8' }).trim();
}
function gitSafe(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

// Resolve a diff base: prefer a real merge-base; fall back to the symmetric
// "commits on HEAD not on origin/main" range when the clone is shallow.
function resolveRange() {
  const mb = gitSafe(['merge-base', 'HEAD', 'origin/main']);
  if (mb) return `${mb}...HEAD`;
  // Shallow fallback: origin/main..HEAD (two-dot) = HEAD-only commits.
  const cnt = gitSafe(['rev-list', '--count', 'origin/main..HEAD']);
  if (cnt !== null) return 'origin/main..HEAD';
  return null;
}

const range = resolveRange();
if (range === null) {
  console.error('[lint-no-second-world] cannot resolve diff base (origin/main unreachable) — refusing to pass blind');
  process.exit(2);
}

// Added production-source lines only. tsc test patterns excluded.
const diff = gitSafe(['diff', range, '--', '*.ts', '*.tsx']);
if (diff === null) {
  console.error(`[lint-no-second-world] git diff failed for range ${range}`);
  process.exit(2);
}

const WORLD_CTOR = /new\s+World\s*\(|createWorld\s*\(/;
const TEST_HUNK = /(__tests__|\.test\.|\.test-d\.)/;

const offenders = [];
let curFile = null;
let curFileIsTest = false;
for (const line of diff.split('\n')) {
  if (line.startsWith('+++ b/')) {
    curFile = line.slice('+++ b/'.length);
    curFileIsTest = TEST_HUNK.test(curFile);
    continue;
  }
  if (!line.startsWith('+') || line.startsWith('+++')) continue;
  if (curFileIsTest) continue;
  const added = line.slice(1);
  if (WORLD_CTOR.test(added)) offenders.push(`${curFile}: ${added.trim()}`);
}

if (offenders.length > 0) {
  console.error(`[lint-no-second-world] AC-17 VIOLATION — feature diff (${range}) adds ${offenders.length} world construction(s) in production engine source:`);
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}

console.log(`[lint-no-second-world] AC-17 OK — no net-new production world in engine diff (${range})`);
process.exit(0);
