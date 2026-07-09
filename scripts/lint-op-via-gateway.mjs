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
//   function names from origin/main, and only flag names NOT in that baseline.
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
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
  const baseNames = new Set();
  // Collect function names that exist on the base tree in store/ files.
  // Matches BOTH `export function name(` and `export async function name(`
  // because some base functions were async and got refactored to non-async
  // wrapper form during M2-M3 migration.
  const BASE_FN_RE = /^export\s+(?:async\s+)?function\s+(\w+)\s*\(/;

  const storeFiles = gitSafe([
    'ls-tree', '--name-only', '-r', base,
    'packages/core/src/store',
  ]);
  if (!storeFiles) return baseNames;

  for (const file of storeFiles.split('\n').map(s => s.trim()).filter(Boolean)) {
    if (!file.endsWith('.ts')) continue;
    const content = gitSafe(['show', `${base}:${file}`]);
    if (!content) continue;
    for (const line of content.split('\n')) {
      const m = line.match(BASE_FN_RE);
      if (m) {
        baseNames.add(m[1]);
      }
    }
  }
  return baseNames;
}

let baselineNames = new Set();
// For synthetic diffs, we want a simpler baseline: just the setter names
// that appear in the diff itself as modified (not new) lines. But for
// fake diffs the test creates entirely fake store files with new names,
// so we skip baseline and let the test control the outcome.
if (diffFileIdx < 0) {
  baselineNames = buildBaseline(baseRef);
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
    const m = added.match(STORE_SETTER_RE);
    if (m) {
      const fnName = m[1];
      // Exempt: init*/bootstrap functions
      if (INIT_BOOTSTRAP_RE.test(added)) continue;
      // Exempt: create*Context DI-context factories (plan-strategy D-2 + §8)
      if (CONTEXT_FACTORY_RE.test(added)) continue;
      // Exempt: create<Thing>(deps: ...) DI factories (plan-strategy D-3 + §8)
      if (DI_FACTORY_RE.test(added)) continue;
      // Exempt: function names already on origin/main baseline
      if (baselineNames.has(fnName)) continue;
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

console.log(`${LABEL} AC-07 OK -- no new operations bypassing gateway in diff (${sourceDesc})`);
process.exit(0);