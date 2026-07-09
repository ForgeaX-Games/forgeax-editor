#!/usr/bin/env node
// lint-no-second-world.mjs — AC-17 diff-scoped "no second world" gate
// (feat-20260630-viewport-2x2-run-x-display-redesign, w28).
//
// AC-17 forbids the feature from building a SECOND engine world. The single
// edit-runtime world (built once via the engine's createApp) hosts both editor
// and game systems (requirements C-1). This gate asserts the feature DIFF adds
// no net-new `new World()` / `createWorld()` in production engine source.
//
// SCANNING DOMAIN — engine submodule only (research Finding 10).
//   This gate runs `git -C packages/engine diff` against the nested engine
//   submodule. Editor-side source (packages/core, packages/edit-runtime, etc.)
//   is NOT in its scan domain — the gate's purpose is to prevent a second engine
//   World from being introduced inside the engine library itself. Editor-side
//   `new World()` calls (e.g. the play-assemble.ts level-load world, plan-strategy
//   D-1/D-2) are legitimate and out of scope by design.
//
// WHY DIFF-SCOPED, NOT ABSOLUTE
//   The engine submodule already contains legitimate `new World()` calls in test
//   fixtures and demo apps. An absolute `count == 0` would be a stale literal
//   that trips on pre-existing code. We count only lines ADDED by this feature's
//   diff range, so pre-existing worlds don't false-positive and a newly introduced
//   one does.
//
// DIFF BASE — the checked-out submodule HEAD (the editor's pinned gitlink), NOT
// engine's own origin/main.
//   The invariant is about the engine lib *as it sits on disk*: has this editor
//   checkout mutated engine source to add a World beyond the commit it pins? The
//   right base is therefore the submodule's own HEAD (always the pinned commit),
//   and the diff is the WORKING TREE against it (`git diff HEAD`) — exactly the
//   on-disk mutation the invariant forbids.
//
// WHY NOT origin/main
//   Diffing against engine's origin/main coupled this gate to engine upstream
//   history it has no business reading. Under CI's `fetch-depth: 1 +
//   submodules: recursive`, the submodule is a shallow clone: `origin/main` is a
//   resolvable REF but its tree object is never fetched, so `git diff
//   origin/main..HEAD` fails with exit 128 → the gate died exit 2 on every PR.
//   A pure pin bump (clean working tree) is engine's OWN CI's domain, not this
//   editor gate's; this gate targets hand-edits to the on-disk engine source.
//
// SHALLOW-CLONE SAFE
//   `git diff HEAD` reads only the checked-out HEAD tree, which is always present
//   locally (it is what the submodule is checked out to). No remote history, no
//   merge-base, no origin/main — immune to shallow clones by construction.
//
// Usage:   node packages/editor/scripts/lint-no-second-world.mjs [enginePath]
// Exits    0 clean · 1 net-new world found · 2 git diff failed (loud).

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Default: the nested engine submodule under the editor package.
const ENGINE = resolve(process.argv[2] ?? resolve(__dirname, '..', 'packages', 'engine'));

function gitSafe(args) {
  try {
    return execFileSync('git', ['-C', ENGINE, ...args], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

// Working-tree changes to engine source vs the pinned submodule HEAD. `git diff
// HEAD` covers both unstaged and staged mutations. Empty when the submodule is
// clean (the common case — the editor PR does not touch engine on disk).
const range = 'HEAD';
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
