#!/usr/bin/env node
// lint-unique-mutator.mjs -- Gate A: "engine world writes go through the single
// EngineFacade mutator" (feat-20260707-editor-trace-ioc M3 t14, plan-strategy §2 D-6).
//
// AC-03 / AC-04 / OOS-2: after the view-scaffold consolidation (M3), every raw
// engine world write — world.set / world.spawn / world.despawn /
// world.allocSharedRef — must live inside the SINGLE EngineFacade implementation
// file (packages/core/src/io/engine-facade.ts). That file is the WRITE-GATE
// DEFINITION ITSELF -- the sole legal home of raw engine world writes. This is
// NOT a growable file white-list (the thing OOS-2 forbids): there is exactly ONE
// legal file and it is the gate's own body. Any diff-added raw world write in any
// OTHER editor source file is a violation.
//
// WHY DIFF-SCOPED WITH BASELINE (following lint-op-via-gateway.mjs precedent):
//   Some legacy files still carry raw world writes that are out of THIS feature's
//   reach (a DAG-isolated package like play-runtime cannot import core's facade;
//   pre-existing core asset resolvers). An absolute whole-repo count would be a
//   stale literal that flags historical debt on every unrelated PR. We flag only
//   NET-NEW raw writes the diff introduces (added `+` lines), so the gate holds
//   the line going forward without demanding a whole-repo sweep first.
//
// WHY ALSO A SHRINKING-BASELINE RATCHET (scripts/.mutator-baseline.json):
//   The diff-scope alone has two blind spots. (1) Pre-existing raw writes are
//   PERMANENTLY invisible — legacy debt can sit forever and is never counted, so
//   "how much debt is left?" is unanswerable. (2) A path rename/move can carry a
//   raw write into a new location without ever appearing as a `+`-added
//   `world.set(` line the diff-scope would flag. To fix both, on TOP of the
//   diff-scope we do a FULL-TREE scan of the exact same violation class and
//   assert `currentFullTreeCount <= recordedBaselineCount`:
//     - current  > recorded -> FAIL (new debt the diff-scope missed / a rename).
//     - current  < recorded -> PASS, and AUTO-REWRITE the baseline DOWN (ratchet),
//                               so the commit captures the shrink and debt can
//                               only monotonically decrease. Never rewrites up.
//     - current == recorded -> PASS silently.
//   The full-scan and the diff-scan share ONE matcher (rawWriteMatch, SSOT) so
//   the two views can never diverge on what "a raw write" is.
//
// THE RULE:
//   A diff-added line in editor source (packages/**/src/**, src/**) that adds a
//   raw `world.set(` / `world.spawn(` / `world.despawn(` / `world.allocSharedRef(`
//   (or a cast-receiver form `).set(` etc. on a `world`-named receiver) is a
//   VIOLATION unless the file is the EngineFacade implementation itself.
//
// EXPLICIT EXCLUSIONS (OOS-10 red line — registry projection layer kept verbatim):
//   - **/protocol.ts + VAG_*  (cross-iframe transport SSOT)
//   - studio surface paths (useSurface) — not in this repo, defensive only
//   - the engine submodule (packages/engine/**) — not editor source
//   - test hunks (__tests__/ + *.test.*)
//   - comment-only lines
//
// NO FILE WHITE-LIST beyond the single facade gate file (OOS-2).
//
// EXIT CODES:
//   0 clean / 1 violation / 2 cannot determine base (refuse to pass blind)
//
// Usage: node scripts/lint-unique-mutator.mjs
//        node scripts/lint-unique-mutator.mjs --diff-file <path>  (synthetic diff)

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const LABEL = '[lint-unique-mutator]';

// ---------------------------------------------------------------------------
// Git helpers (same base-resolution discipline as lint-op-via-gateway.mjs)
// ---------------------------------------------------------------------------
function git(args) {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' }).trim();
}
function gitSafe(args) {
  try { return git(args); } catch { return null; }
}

function resolveBaseRef() {
  if (gitSafe(['rev-parse', '--verify', '--quiet', 'origin/main']) !== null) {
    return 'origin/main';
  }
  const baseBranch = process.env.GITHUB_BASE_REF || 'main';
  const fetched = gitSafe([
    'fetch', '--depth=1', 'origin',
    `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
  ]) !== null
    || gitSafe(['fetch', '--depth=1', 'origin', baseBranch]) !== null;
  if (!fetched) return null;
  return gitSafe(['rev-parse', '--verify', '--quiet', 'FETCH_HEAD']);
}

// ---------------------------------------------------------------------------
// Resolve diff content: --diff-file flag or live git
// ---------------------------------------------------------------------------
const diffFileIdx = process.argv.indexOf('--diff-file');
let diffText;
let sourceDesc;

if (diffFileIdx >= 0) {
  const diffPath = process.argv[diffFileIdx + 1];
  if (!diffPath) {
    console.error(`${LABEL} --diff-file requires a path argument`);
    process.exit(2);
  }
  diffText = readFileSync(diffPath, 'utf8');
  sourceDesc = `synthetic diff: ${diffPath}`;
} else {
  const baseRef = resolveBaseRef();
  if (baseRef === null) {
    console.error(`${LABEL} cannot resolve diff base (origin/main unreachable, shallow fetch failed) -- refusing to pass blind`);
    process.exit(2);
  }
  const mb = gitSafe(['merge-base', 'HEAD', baseRef]);
  const range = mb ? `${mb}...HEAD` : `${baseRef}..HEAD`;
  const diffResult = gitSafe(['diff', range, '--', '*.ts', '*.tsx']);
  if (diffResult === null) {
    console.error(`${LABEL} git diff failed for range ${range}`);
    process.exit(2);
  }
  diffText = diffResult;
  sourceDesc = `git diff ${range}`;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Raw world write forms — direct (`world.set(`) and cast-receiver (`).set(`) that
// follow a `world`-named object. We keep the mutator verb list tight to the four
// write primitives AC-04 enumerates (get/read forms are never writes).
const MUTATORS = 'set|spawn|despawn|allocSharedRef';
// Direct: an identifier ending in `world` (world, deps.world, gateway.doc.world,
// _rawWorld()) followed by `.set(` etc. Case-insensitive on the World suffix so
// `myWorld.set(` and `world.set(` both catch.
const DIRECT_RE = new RegExp(`\\b[\\w.]*[Ww]orld(?:\\(\\))?\\.(${MUTATORS})\\s*\\(`);
// Cast-receiver: `(x as never as { set: … }).set(` — the parenthesised cast form
// used in host-boot.ts to reach the loosely-typed world. Flag `).set(` when a
// `world` token appears earlier on the same line (avoids flagging unrelated
// `.set(` on Maps/Sets).
const CAST_RE = new RegExp(`\\)\\.(${MUTATORS})\\s*\\(`);
const WORLD_TOKEN_RE = /\b[Ww]orld\b/;

// SSOT MATCHER: the single decision "is this line a raw world write?", shared by
// BOTH the diff-scan (added `+` lines) and the full-tree ratchet scan. Factoring
// it here guarantees the two views can never disagree on the violation class.
// Returns true for a direct (`world.set(`) or cast-receiver (`).set(` near a
// world token) raw write; comment-only lines are never a write.
function rawWriteMatch(text) {
  if (isCommentLine(text)) return false;
  const direct = DIRECT_RE.test(text);
  const cast = CAST_RE.test(text) && WORLD_TOKEN_RE.test(text);
  return direct || cast;
}

// The single legal gate file (D-6): the EngineFacade implementation itself.
const FACADE_FILE = 'packages/core/src/io/engine-facade.ts';

// OOS-10 registry-projection exclusions (basename or path fragment).
const EXCLUDED_BASENAMES = new Set([
  'protocol.ts',
]);
const EXCLUDED_PATH_FRAGMENTS = [
  '/vag/',
  '/surface/',
  'useSurface',
];

// Editor source scope: only flag inside editor packages / top-level src.
const EDITOR_SRC_RE = /(^|.*\/)(packages\/[^/]+\/src\/|src\/)/;
const ENGINE_SUBMODULE_RE = /packages\/engine\//;
const TEST_HUNK_RE = /(__tests__|\.test\.|\.test-d\.)/;

function isExcludedFile(file) {
  if (file === FACADE_FILE) return true;              // the gate body itself
  if (ENGINE_SUBMODULE_RE.test(file)) return true;    // engine submodule
  if (TEST_HUNK_RE.test(file)) return true;           // test hunks
  const basename = file.split('/').pop();
  if (EXCLUDED_BASENAMES.has(basename)) return true;  // OOS-10 registry layer
  for (const frag of EXCLUDED_PATH_FRAGMENTS) if (file.includes(frag)) return true;
  return false;
}

// A line is comment-only when its added text (sans leading `+`) starts with
// `//`, `*`, or `/*` — the raw-write forms inside a doc comment are prose.
function isCommentLine(added) {
  const t = added.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

// ---------------------------------------------------------------------------
// Scan diff
// ---------------------------------------------------------------------------
const offenders = [];
let curFile = null;
let curFileExcluded = false;
let curFileInScope = false;

for (const line of diffText.split('\n')) {
  if (line.startsWith('+++ b/')) {
    curFile = line.slice('+++ b/'.length);
    curFileExcluded = isExcludedFile(curFile);
    curFileInScope = EDITOR_SRC_RE.test(curFile);
    continue;
  }
  if (!line.startsWith('+') || line.startsWith('+++')) continue;
  if (curFileExcluded || !curFileInScope) continue;

  const added = line.slice(1);
  if (rawWriteMatch(added)) {
    offenders.push(`${curFile}: ${added.trim()}`);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (offenders.length > 0) {
  console.error(`${LABEL} AC-04 VIOLATION -- feature diff (${sourceDesc}) adds ${offenders.length} raw engine world write(s) outside the EngineFacade gate:`);
  for (const o of offenders) console.error(`  ${o}`);
  console.error(`${LABEL} Raw world.set/spawn/despawn/allocSharedRef is legal ONLY in ${FACADE_FILE} (the write-gate definition, plan-strategy §2 D-6).`);
  console.error(`${LABEL} View scaffolding must write through ctx.engine (the facade proxy); document data through gateway.dispatch. There is no file white-list (OOS-2).`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// FULL-TREE RATCHET (shrinking baseline) — see the "WHY ALSO A ... RATCHET"
// header note. Runs AFTER the diff-scope check so a fresh `+`-added violation
// is reported with its exact line first; this second pass catches debt the
// diff-scope structurally cannot see (pre-existing writes, path renames) and
// ratchets the recorded count strictly downward.
// ---------------------------------------------------------------------------

// Test/override hooks: --baseline-file lets a test point at a scratch baseline
// JSON; --scan-root lets a test point the full-tree scan at a synthetic tree
// laid out as <root>/packages/<pkg>/src/... so the same EDITOR_SRC_RE +
// exclusions apply. Both default to the real repo for production runs.
function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}
const BASELINE_FILE = argVal('--baseline-file') || join(__dirname, '.mutator-baseline.json');
const SCAN_ROOT = argVal('--scan-root') || REPO_ROOT;

// Recursively collect *.ts/*.tsx files under a base dir, returning paths
// RELATIVE to that base (so the existing EDITOR_SRC_RE / exclusion regexes,
// which key off `packages/<pkg>/src/` fragments, apply unchanged).
function collectSourceFiles(baseDir) {
  const out = [];
  function walk(absDir, relDir) {
    let entries;
    try { entries = readdirSync(absDir); } catch { return; }
    for (const name of entries) {
      if (name === 'node_modules' || name === '.git') continue;
      const abs = join(absDir, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) walk(abs, rel);
      else if (/\.tsx?$/.test(rel)) out.push({ abs, rel });
    }
  }
  for (const root of ['packages', 'src']) {
    walk(join(baseDir, root), root);
  }
  return out;
}

// Count raw world writes across the whole tree, reusing rawWriteMatch (SSOT) and
// the SAME file exclusions the diff-scan uses. Returns { count, hits } sorted.
function fullTreeRawWriteScan(baseDir) {
  const hits = [];
  for (const { abs, rel } of collectSourceFiles(baseDir)) {
    if (isExcludedFile(rel)) continue;
    if (!EDITOR_SRC_RE.test(rel)) continue;
    let content;
    try { content = readFileSync(abs, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (rawWriteMatch(lines[i])) hits.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
    }
  }
  hits.sort();
  return { count: hits.length, hits };
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
} catch (e) {
  console.error(`${LABEL} cannot read ratchet baseline ${BASELINE_FILE}: ${e.message} -- refusing to pass blind`);
  process.exit(2);
}
const recorded = baseline.rawWriteCount;
if (typeof recorded !== 'number') {
  console.error(`${LABEL} baseline ${BASELINE_FILE} missing numeric "rawWriteCount" -- refusing to pass blind`);
  process.exit(2);
}

const { count: currentCount, hits: currentHits } = fullTreeRawWriteScan(SCAN_ROOT);

if (currentCount > recorded) {
  console.error(`${LABEL} RATCHET VIOLATION -- full-tree raw world writes = ${currentCount}, baseline = ${recorded} (debt grew ${currentCount - recorded}).`);
  console.error(`${LABEL} The diff-scope missed this (pre-existing write moved, or path renamed). Current raw writes:`);
  for (const h of currentHits) console.error(`  ${h}`);
  console.error(`${LABEL} Route the new write through ${FACADE_FILE} (or ctx.engine / gateway.dispatch). The baseline never rises.`);
  process.exit(1);
}

if (currentCount < recorded) {
  baseline.rawWriteCount = currentCount;
  writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`${LABEL} RATCHET DOWN -- full-tree raw world writes dropped ${recorded} -> ${currentCount}; baseline rewritten (${BASELINE_FILE}). Commit the shrink.`);
}

console.log(`${LABEL} AC-04 OK -- no raw world writes outside the EngineFacade gate in diff (${sourceDesc}); full-tree count ${currentCount} <= baseline ${recorded === currentCount ? recorded : `(ratcheted to ${currentCount})`}`);
process.exit(0);
