#!/usr/bin/env node
// lint-op-via-gateway.mjs -- M5 gate B: "operations must go through EditGateway"
// (feat-20260706-editor-op-gateway-single-entry-b-catalog-defineop, m5-w3).
//
// AC-07 forbids new scattered store mutators that bypass the gateway. After the
// three-domain consolidation (M1-M4), all state-changing operations must go
// through gateway.dispatch() (document/session/transient) or the D-11 seam
// (registerSessionApplier). This gate asserts the feature DIFF adds no
// net-new bare export function setters in non-exempt store/ files.
//
// WHY DIFF-SCOPED WITH BASELINE:
//   Legacy store/ files already contain `export function set*` (the pre-gateway
//   setters that were modified during M1-M4 migration but are now sealed).
//   An absolute count would be a stale literal. We build a BASELINE of setter
//   IDENTITIES from origin/main, and only flag identities NOT in that baseline.
//
// WHY THE BASELINE IS PATH-QUALIFIED (`file:name`, not bare `name`):
//   A bare-name baseline had a reachable escape hole: a NEW setter that REUSES a
//   baselined name in a DIFFERENT file was silently exempt (baselineNames.has
//   matched on name alone). Keying by `file:fnName` closes it — a name is
//   grandfathered only in the exact file it was grandfathered in; the same name
//   born in a new file is caught. The init*/bootstrap/DI-factory/exempt-file
//   carve-outs are unchanged.
//
// WHY ALSO A SHRINKING-BASELINE RATCHET (scripts/.mutator-baseline.json):
//   The diff-scope + name-baseline still can't answer "how many bypassing setters
//   remain?" and a file rename can move a sealed setter to a new path (a new
//   `file:name` identity the diff-scope, keyed on `+`-added lines, may not flag as
//   net-new against the moved-from identity). So ON TOP of the diff-scope we do a
//   FULL-TREE scan of the SAME violation class (every store/ setter that would be
//   flagged were it net-new) and assert `currentFullTreeCount <= recorded`:
//     - current  > recorded -> FAIL (new debt / a rename created a new identity).
//     - current  < recorded -> PASS + AUTO-REWRITE the baseline list DOWN to the
//                               current sorted set (ratchet). Never rewrites up.
//     - current == recorded -> PASS silently.
//   The full-scan and diff-scan share ONE setter classifier (classifySetter,
//   SSOT) so the two views agree on what a bypassing setter is.
//
// TWO RULES (plan-strategy D-5):
//   Rule (a): diff-added lines in `packages/core/src/store/**` matching
//             `export function (set|toggle|request|switch|save|load|create|replace)\w*\(`
//             AND the function name is NOT in the origin/main baseline
//             -> VIOLATION (new scattered mutator bypassing gateway)
//   Rule (b): diff-added lines in UI three packages (panels/content-browser/
//             edit-runtime src/**) matching import of a private-applier setter
//             module (e.g. `from.*store/selection`) -> VIOLATION
//
// EXEMPTION LIST (D-5, filename white-list):
//     ref-request.ts     -- VAG postMessage, no local state change
//     mesh-stats.ts      -- derived stats broadcast
//     assets-changed.ts  -- change signal broadcast
//     disk-watch.ts      -- infrastructure init/teardown
//   Also exempt: functions named init* or bootstrap (infrastructure init), and
//   create*Context DI-context factories (e.g. createScenePersistenceContext,
//   feat-20260709 M1 / plan-strategy D-2 + §8 <Thing>Context naming). Such a
//   factory RETURNS a fresh state-carrier object; it dispatches nothing and
//   mutates no global — same "not a gateway-bypassing operation" category as
//   init*/bootstrap*. The `create` verb in STORE_SETTER_RE targets gateway ops
//   like createSceneFile, NOT DI factories; the `Context` suffix disambiguates.
//
// TEST HUNK EXEMPTION: skips __tests__/ and *.test.* paths.
//
// EXIT CODES:
//   0 clean (no new violations) / 1 violation / 2 cannot determine base
//
// Usage: node scripts/lint-op-via-gateway.mjs
//        node scripts/lint-op-via-gateway.mjs --diff-file <path>  (synthetic diff)
// Exits: 0 | 1 | 2

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Git helpers (shared between baseline collection and diff)
// ---------------------------------------------------------------------------
function git(args) {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' }).trim();
}
function gitSafe(args) {
  try { return git(args); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Resolve a base commit-ish (SHA or ref) that BOTH the diff range and the
// baseline scan hang off. Unlike lint-no-second-world.mjs (which runs inside
// the engine SUBMODULE, whose clone carries origin/main), gate B runs at the
// EDITOR REPO ROOT. Under `actions/checkout@v5` + `fetch-depth: 1` the editor
// checkout is a shallow, detached-HEAD PR merge ref with NO `origin/main`
// remote-tracking ref, so a bare `origin/main` lookup fails and the gate would
// refuse-to-pass-blind (exit 2) on every PR. We recover the base honestly:
//
//   1. If `origin/main` already resolves (local dev / full clone) -> use it.
//   2. Else fetch it shallowly. `checkout@v5` keeps the `origin` remote wired,
//      so a depth-1 fetch of the PR target branch pulls exactly the base tip.
//      GitHub Actions exposes the PR target branch name in GITHUB_BASE_REF
//      (e.g. `main`); off CI we fall back to `main`. We anchor on FETCH_HEAD
//      (a stable SHA) rather than assuming the fetch repopulates
//      refs/remotes/origin/main, since checkout may pin a narrow refspec.
//   3. Only if the fetch also fails (e.g. no network) do we return null and
//      keep the honest exit-2 refuse-to-pass-blind behaviour. We never silently
//      pass (which would be a false green).
function resolveBaseRef() {
  // (1) origin/main already present (local dev / non-shallow clone).
  if (gitSafe(['rev-parse', '--verify', '--quiet', 'origin/main']) !== null) {
    return 'origin/main';
  }
  // (2) Shallow CI checkout: fetch the PR base branch one commit deep.
  const baseBranch = process.env.GITHUB_BASE_REF || 'main';
  // `+refs/heads/<b>:refs/remotes/origin/<b>` also updates the tracking ref
  // when the refspec allows; either way FETCH_HEAD lands on the fetched tip.
  const fetched = gitSafe([
    'fetch', '--depth=1', 'origin',
    `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
  ]) !== null
    // Fallback to a plain branch-name fetch if the explicit refspec is rejected.
    || gitSafe(['fetch', '--depth=1', 'origin', baseBranch]) !== null;
  if (!fetched) return null;
  const sha = gitSafe(['rev-parse', '--verify', '--quiet', 'FETCH_HEAD']);
  return sha; // null if FETCH_HEAD somehow unresolvable -> caller refuses blind.
}

// ---------------------------------------------------------------------------
// Resolve diff content: --diff-file flag or live git
// ---------------------------------------------------------------------------
const diffFileIdx = process.argv.indexOf('--diff-file');
let diffText;
let sourceDesc;
// The base commit-ish shared by the diff range and the baseline scan. Resolved
// once for the live path; unused (null) for the synthetic --diff-file path.
let baseRef = null;

if (diffFileIdx >= 0) {
  const diffPath = process.argv[diffFileIdx + 1];
  if (!diffPath) {
    console.error('[lint-op-via-gateway] --diff-file requires a path argument');
    process.exit(2);
  }
  diffText = readFileSync(diffPath, 'utf8');
  sourceDesc = `synthetic diff: ${diffPath}`;
} else {
  // Resolve the base ONCE (with shallow-CI fetch fallback), then derive the
  // diff range from it. Both the range and buildBaseline() reuse `baseRef` so a
  // single successful fetch serves both — we never fetch twice or drift bases.
  baseRef = resolveBaseRef();
  if (baseRef === null) {
    console.error('[lint-op-via-gateway] cannot resolve diff base (origin/main unreachable, and shallow fetch of PR base failed) -- refusing to pass blind');
    process.exit(2);
  }

  function resolveRange(base) {
    const mb = gitSafe(['merge-base', 'HEAD', base]);
    if (mb) return `${mb}...HEAD`;
    const cnt = gitSafe(['rev-list', '--count', `${base}..HEAD`]);
    if (cnt !== null) return `${base}..HEAD`;
    return null;
  }

  const range = resolveRange(baseRef);
  if (range === null) {
    console.error(`[lint-op-via-gateway] cannot compute diff range from base ${baseRef} -- refusing to pass blind`);
    process.exit(2);
  }

  const diffResult = gitSafe(['diff', range, '--', '*.ts', '*.tsx']);
  if (diffResult === null) {
    console.error(`[lint-op-via-gateway] git diff failed for range ${range}`);
    process.exit(2);
  }
  diffText = diffResult;
  sourceDesc = `git diff ${range}`;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Rule (a): export function matching set/toggle/request/switch/save/load/create/replace*
// Captures function name from the match
const STORE_SETTER_RE = /^export\s+function\s+((?:set|toggle|request|switch|save|load|create|replace)\w*)\s*\(/;

// Rule (b): direct import from a store/ setter module (not through store.ts facade)
const STORE_DIRECT_IMPORT_RE = /^import\s+.*\bfrom\s+['"].*store\/(selection|gizmo-mode|hover|field-preview|asset-selection|frame-request|rename-request|scene-persistence)['"]/;

// Exemption list: files not considered "state-mutating operations" (D-5)
const EXEMPT_FILES = new Set([
  'ref-request.ts',
  'mesh-stats.ts',
  'assets-changed.ts',
  'disk-watch.ts',
]);

// Also exempt functions whose name starts with 'init' or 'bootstrap'
const INIT_BOOTSTRAP_RE = /^export\s+function\s+(init|bootstrap)\w*\s*\(/;

// Also exempt create*Context DI-context factories (plan-strategy D-2 + §8):
// they return a fresh state-carrier object, dispatching nothing / mutating no
// global — not a gateway-bypassing operation. Scoped to the `Context` suffix so
// real store ops (createSceneFile etc.) are still caught by STORE_SETTER_RE.
const CONTEXT_FACTORY_RE = /^export\s+function\s+create\w*Context\s*\(/;

// Also exempt create<Thing>(deps: <Thing>Deps) DI factories (feat-20260709 M2 /
// plan-strategy D-3 + §8 naming). The run-lifecycle create<Thing>(deps) form
// extracts a persistence cluster (createDiskIo / createSceneList /
// createPlayConfig / createStorage) into a factory whose whole dependency edge
// -- including the gateway + fetch -- is the injected `deps` object. The
// factory itself dispatches nothing and mutates no module global; its RETURNED
// functions route real ops through the gateway exactly as before (the
// composition root wires them). Same "not a gateway-bypassing operation"
// category as create*Context. Scoped to a first parameter literally named `deps`
// so real store ops (createSceneFile(id, duplicateCurrent) etc.) -- which never
// take a single `deps` param -- are still caught by STORE_SETTER_RE.
const DI_FACTORY_RE = /^export\s+function\s+create\w+\(\s*deps\s*:/;

// Test hunk exemption pattern
const TEST_HUNK_RE = /(__tests__|\.test\.|\.test-d\.)/;

// SSOT CLASSIFIER: "is this line a gateway-bypassing store setter?", shared by
// the diff-scan (rule a) and the full-tree ratchet scan. Returns the setter's
// function name if it is a bypassing setter (matches STORE_SETTER_RE and is NOT
// an init*/bootstrap infra fn, a create*Context factory, or a create<Thing>(deps:)
// DI factory); otherwise null. Note: this does NOT apply the origin/main
// name/identity baseline — that grandfathering is layered on top by each caller,
// because the ratchet wants the TOTAL bypassing-setter population (baselined ones
// included) while the diff-scan wants only NET-NEW identities.
function classifySetter(text) {
  const m = text.match(STORE_SETTER_RE);
  if (!m) return null;
  if (INIT_BOOTSTRAP_RE.test(text)) return null;   // infra init
  if (CONTEXT_FACTORY_RE.test(text)) return null;  // create*Context DI factory
  if (DI_FACTORY_RE.test(text)) return null;       // create<Thing>(deps:) DI factory
  return m[1];
}

// Store path pattern (rule a only applies to store/**)
const STORE_PATH_RE = /packages\/core\/src\/store\//;

// UI three-package path pattern (rule b only applies to UI packages)
const UI_PACKAGE_RE = /packages\/(panels|content-browser|edit-runtime)\/src\//;

// ---------------------------------------------------------------------------
// Build baseline: setter function names that exist on the diff base
// These are NOT new -- they were merely modified during migration.
// `base` is the same commit-ish resolveBaseRef() produced (origin/main on local
// dev, or the shallow-fetched FETCH_HEAD SHA in CI), so the baseline reads from
// exactly the tree the diff range is measured against.
// ---------------------------------------------------------------------------
function buildBaseline(base) {
  // PATH-QUALIFIED identities: `file:fnName`. Keying by file closes the
  // name-reuse hole — a name is grandfathered only in the file it lived in on
  // the base, so the same name reborn in a DIFFERENT file is NOT auto-exempt.
  const baseIdentities = new Set();
  // Collect function names that exist on the base tree in store/ files.
  // Matches BOTH `export function name(` and `export async function name(`
  // because some base functions were async and got refactored to non-async
  // wrapper form during M2-M3 migration.
  const BASE_FN_RE = /^export\s+(?:async\s+)?function\s+(\w+)\s*\(/;

  const storeFiles = gitSafe([
    'ls-tree', '--name-only', '-r', base,
    'packages/core/src/store',
  ]);
  if (!storeFiles) return baseIdentities;

  for (const file of storeFiles.split('\n').map(s => s.trim()).filter(Boolean)) {
    if (!file.endsWith('.ts')) continue;
    const content = gitSafe(['show', `${base}:${file}`]);
    if (!content) continue;
    for (const line of content.split('\n')) {
      const m = line.match(BASE_FN_RE);
      if (m) {
        baseIdentities.add(`${file}:${m[1]}`);
      }
    }
  }
  return baseIdentities;
}

let baselineIdentities = new Set();
// For synthetic diffs, we want a simpler baseline: just the setter names
// that appear in the diff itself as modified (not new) lines. But for
// fake diffs the test creates entirely fake store files with new names,
// so we skip baseline and let the test control the outcome — UNLESS the test
// explicitly seeds path-qualified identities via --baseline-identities
// (comma-separated `file:name`), which lets the falsification test exercise the
// exact grandfathering `buildBaseline` produces for the live path.
if (diffFileIdx < 0) {
  baselineIdentities = buildBaseline(baseRef);
} else {
  const seedIdx = process.argv.indexOf('--baseline-identities');
  if (seedIdx >= 0 && process.argv[seedIdx + 1]) {
    for (const id of process.argv[seedIdx + 1].split(',').map(s => s.trim()).filter(Boolean)) {
      baselineIdentities.add(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Scan diff
// ---------------------------------------------------------------------------
const offenders = [];
let curFile = null;
let curFileIsTest = false;
let curFileIsExempt = false;
let curFileInStore = false;
let curFileInUI = false;

for (const line of diffText.split('\n')) {
  // Track file header
  if (line.startsWith('+++ b/')) {
    curFile = line.slice('+++ b/'.length);
    const basename = curFile.split('/').pop();
    curFileIsTest = TEST_HUNK_RE.test(curFile);
    curFileIsExempt = EXEMPT_FILES.has(basename);
    curFileInStore = STORE_PATH_RE.test(curFile);
    curFileInUI = UI_PACKAGE_RE.test(curFile);
    continue;
  }

  // Only scan added lines
  if (!line.startsWith('+') || line.startsWith('+++')) continue;
  if (curFileIsTest) continue;

  const added = line.slice(1);

  // Rule (a): new bare setter in store/
  if (curFileInStore && !curFileIsExempt) {
    // Shared classifier applies STORE_SETTER_RE + init/bootstrap/Context/DI carve-outs.
    const fnName = classifySetter(added);
    if (fnName) {
      // Exempt: identity already on origin/main baseline. PATH-QUALIFIED
      // (`file:name`) — a baselined name reused in a DIFFERENT file is NOT exempt.
      if (baselineIdentities.has(`${curFile}:${fnName}`)) continue;
      offenders.push(`[rule-a] ${curFile}: ${added.trim()}`);
    }
  }

  // Rule (b): direct import from store/ setter module in UI packages
  if (curFileInUI) {
    if (STORE_DIRECT_IMPORT_RE.test(added)) {
      offenders.push(`[rule-b] ${curFile}: ${added.trim()}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const LABEL = '[lint-op-via-gateway]';

if (offenders.length > 0) {
  console.error(`${LABEL} AC-07 VIOLATION -- feature diff (${sourceDesc}) adds ${offenders.length} operation(s) that bypass EditGateway:`);
  for (const o of offenders) console.error(`  ${o}`);
  console.error(`${LABEL} All state-changing operations must go through gateway.dispatch() or the D-11 registerSessionApplier seam.`);
  console.error(`${LABEL} See plan-strategy D-5 for the exemption list and rule details.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// FULL-TREE RATCHET (shrinking baseline) — see the "WHY ALSO A ... RATCHET"
// header note. Runs AFTER the diff-scope check so a net-new bypassing setter is
// reported with its exact line first; this pass catches debt the diff-scope
// structurally cannot see and ratchets the recorded population strictly down.
// ---------------------------------------------------------------------------
function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}
const BASELINE_FILE = argVal('--baseline-file') || join(__dirname, '.mutator-baseline.json');
const SCAN_ROOT = argVal('--scan-root') || REPO_ROOT;

// Recursively collect *.ts files under <root>/packages/core/src/store, returning
// paths RELATIVE to <root> so the `file:name` identity matches buildBaseline().
function collectStoreFiles(baseDir) {
  const out = [];
  const storeRel = 'packages/core/src/store';
  function walk(absDir, relDir) {
    let entries;
    try { entries = readdirSync(absDir); } catch { return; }
    for (const name of entries) {
      if (name === 'node_modules' || name === '.git') continue;
      const abs = join(absDir, name);
      const rel = `${relDir}/${name}`;
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) walk(abs, rel);
      else if (rel.endsWith('.ts')) out.push({ abs, rel });
    }
  }
  walk(join(baseDir, storeRel), storeRel);
  return out;
}

// The TOTAL population of gateway-bypassing store setters across the tree, as
// sorted `file:name` identities, reusing classifySetter (SSOT) + the SAME
// exempt-file / test-hunk carve-outs the diff-scan uses.
function fullTreeBypassingSetters(baseDir) {
  const ids = [];
  for (const { abs, rel } of collectStoreFiles(baseDir)) {
    if (TEST_HUNK_RE.test(rel)) continue;
    const basename = rel.split('/').pop();
    if (EXEMPT_FILES.has(basename)) continue;
    let content;
    try { content = readFileSync(abs, 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      const fnName = classifySetter(line);
      if (fnName) ids.push(`${rel}:${fnName}`);
    }
  }
  ids.sort();
  return ids;
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
} catch (e) {
  console.error(`${LABEL} cannot read ratchet baseline ${BASELINE_FILE}: ${e.message} -- refusing to pass blind`);
  process.exit(2);
}
const recorded = baseline.gatewayBaselineSetters;
if (!Array.isArray(recorded)) {
  console.error(`${LABEL} baseline ${BASELINE_FILE} missing array "gatewayBaselineSetters" -- refusing to pass blind`);
  process.exit(2);
}

const current = fullTreeBypassingSetters(SCAN_ROOT);

if (current.length > recorded.length) {
  const recordedSet = new Set(recorded);
  const added = current.filter(id => !recordedSet.has(id));
  console.error(`${LABEL} RATCHET VIOLATION -- full-tree bypassing store setters = ${current.length}, baseline = ${recorded.length} (debt grew ${current.length - recorded.length}).`);
  console.error(`${LABEL} The diff-scope missed this (identity moved via rename, or a new bypassing setter slipped in). New identities:`);
  for (const id of added.length ? added : current) console.error(`  ${id}`);
  console.error(`${LABEL} Route it through gateway.dispatch() / registerSessionApplier. The baseline never rises.`);
  process.exit(1);
}

if (current.length < recorded.length) {
  baseline.gatewayBaselineSetters = current; // already sorted -> deterministic
  writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`${LABEL} RATCHET DOWN -- full-tree bypassing store setters dropped ${recorded.length} -> ${current.length}; baseline rewritten (${BASELINE_FILE}). Commit the shrink.`);
}

console.log(`${LABEL} AC-07 OK -- no new operations bypassing gateway in diff (${sourceDesc}); full-tree bypassing setters ${current.length} <= baseline ${recorded.length}`);
process.exit(0);