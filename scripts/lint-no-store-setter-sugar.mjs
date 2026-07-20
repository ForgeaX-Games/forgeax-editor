#!/usr/bin/env node
// lint-no-store-setter-sugar.mjs -- recurrence guard against write-side setter
// sugar in store modules (feat-20260707-editor-trace-ioc M3 t15, plan-strategy
// §2 D-9, requirements AC-23).
//
// After M3 deletes the 10 write-side setters (setSelection/setGizmoMode/…) whose
// bodies were nothing but `gateway.dispatch({...})`, this gate stops them coming
// back. A store-module `export function` whose body is JUST a single
// `gateway.dispatch(...)` call re-wraps the one gateway door in a second sugar
// layer — the reader now has TWO names for "dispatch this op" (violates SSOT §1
// / the single-entry razor). The one legal door is `gateway.dispatch` itself;
// UI + host call it directly.
//
// WHY A SEPARATE SCRIPT FROM Gate A (D-9): Gate A guards raw `world.*` writes;
// this guards `export function … { gateway.dispatch(…) }` sugar. Different
// predicate, different false-positive surface — merging would dilute both.
//
// WHY DIFF-SCOPED (following lint-op-via-gateway.mjs precedent): legacy store
// files may still carry historical helpers; we flag only NET-NEW added setter
// sugar so the gate holds the line without a whole-repo sweep first.
//
// THE RULE:
//   In packages/core/src/store/**, a diff-added block of the shape
//       export function <name>(<args>): <ret> {
//         gateway.dispatch({ kind: '…', … });
//       }
//   (a one-statement body that is exactly a gateway.dispatch call, optionally
//   `return`ed) is a VIOLATION. The reader should call gateway.dispatch directly.
//
//   READ-SIDE pub/sub exports (get*/use*/on*Change and any function whose body
//   is NOT a lone gateway.dispatch) are COMPLIANT — reads are orthogonal to the
//   single write door (research F-7).
//
// EXCLUSIONS: test hunks (__tests__/ + *.test.*); the engine submodule.
//
// EXIT CODES: 0 clean / 1 violation / 2 cannot determine base.
//
// Usage: node scripts/lint-no-store-setter-sugar.mjs
//        node scripts/lint-no-store-setter-sugar.mjs --diff-file <path>

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const LABEL = '[lint-no-store-setter-sugar]';

function git(args) {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' }).trim();
}
function gitSafe(args) {
  try { return git(args); } catch { return null; }
}

function resolveBaseRef() {
  if (gitSafe(['rev-parse', '--verify', '--quiet', 'origin/main']) !== null) return 'origin/main';
  const baseBranch = process.env.GITHUB_BASE_REF || 'main';
  const fetched = gitSafe([
    'fetch', '--depth=1', 'origin',
    `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
  ]) !== null || gitSafe(['fetch', '--depth=1', 'origin', baseBranch]) !== null;
  if (!fetched) return null;
  return gitSafe(['rev-parse', '--verify', '--quiet', 'FETCH_HEAD']);
}

// ---------------------------------------------------------------------------
// Resolve diff content
// ---------------------------------------------------------------------------
const diffFileIdx = process.argv.indexOf('--diff-file');
let diffText;
let sourceDesc;

if (diffFileIdx >= 0) {
  const diffPath = process.argv[diffFileIdx + 1];
  if (!diffPath) { console.error(`${LABEL} --diff-file requires a path`); process.exit(2); }
  diffText = readFileSync(diffPath, 'utf8');
  sourceDesc = `synthetic diff: ${diffPath}`;
} else {
  const baseRef = resolveBaseRef();
  if (baseRef === null) {
    console.error(`${LABEL} cannot resolve diff base -- refusing to pass blind`);
    process.exit(2);
  }
  const mb = gitSafe(['merge-base', 'HEAD', baseRef]);
  const range = mb ? `${mb}...HEAD` : `${baseRef}..HEAD`;
  const diffResult = gitSafe(['diff', range, '--', 'packages/core/src/store/*.ts']);
  if (diffResult === null) { console.error(`${LABEL} git diff failed for ${range}`); process.exit(2); }
  diffText = diffResult;
  sourceDesc = `git diff ${range}`;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const STORE_PATH_RE = /packages\/core\/src\/store\//;
const TEST_HUNK_RE = /(__tests__|\.test\.|\.test-d\.)/;
// export function <name>( -- capture the name for the message.
const EXPORT_FN_RE = /^\s*export\s+function\s+(\w+)\s*\(/;
// A lone gateway.dispatch statement (optionally returned), the setter-sugar tell.
const DISPATCH_ONLY_RE = /^\s*(?:return\s+)?gateway\.dispatch\s*\(/;
// A closing brace on its own line ends the one-statement body.
const CLOSE_BRACE_RE = /^\s*\}/;

// ---------------------------------------------------------------------------
// Scan diff: reconstruct added-line runs per file, look for the 3-line signature
//   export function X(...) {   /  gateway.dispatch(...)   /  }
// allowing the signature + dispatch to span (a multi-line signature is rare for
// these one-liners; we handle the common single-line-signature case + a small
// lookahead for the dispatch statement before the closing brace).
// ---------------------------------------------------------------------------
const offenders = [];
let curFile = null;
let curFileScoped = false;

// Collected added lines (with original text) per current file, in order.
let addedLines = [];

function flushFile() {
  if (!curFileScoped) { addedLines = []; return; }
  // Walk the added lines looking for the setter-sugar signature.
  for (let i = 0; i < addedLines.length; i++) {
    const m = addedLines[i].match(EXPORT_FN_RE);
    if (!m) continue;
    const name = m[1];
    // Find the opening brace: same line or a following added line.
    let j = i;
    let sawOpen = addedLines[i].includes('{');
    while (!sawOpen && j + 1 < addedLines.length) {
      j++;
      if (addedLines[j].includes('{')) sawOpen = true;
    }
    if (!sawOpen) continue;
    // Next meaningful added line after the opening brace should be the dispatch,
    // and the one after that a closing brace, for the body to be "just dispatch".
    // Scan forward from j+1 for the first non-blank added line.
    let k = j + 1;
    while (k < addedLines.length && addedLines[k].trim() === '') k++;
    if (k >= addedLines.length) continue;
    if (!DISPATCH_ONLY_RE.test(addedLines[k])) continue;
    // After the dispatch statement, the next non-blank added line should close
    // the function. The dispatch may span multiple lines; find the line that
    // ends the statement (contains `});` or `);`) then expect a `}` next.
    let e = k;
    while (e < addedLines.length && !/\);\s*$/.test(addedLines[e])) e++;
    let c = e + 1;
    while (c < addedLines.length && addedLines[c].trim() === '') c++;
    if (c < addedLines.length && CLOSE_BRACE_RE.test(addedLines[c])) {
      offenders.push(`${curFile}: export function ${name}(...) { gateway.dispatch(...) }`);
    }
  }
  addedLines = [];
}

for (const line of diffText.split('\n')) {
  if (line.startsWith('+++ b/')) {
    flushFile();
    curFile = line.slice('+++ b/'.length);
    curFileScoped = STORE_PATH_RE.test(curFile) && !TEST_HUNK_RE.test(curFile);
    continue;
  }
  if (line.startsWith('@@')) {
    // Hunk boundary — a new run of context; a function can't straddle hunks in a
    // way we care about, so reset the added-line buffer per hunk to avoid
    // cross-hunk false joins. (flush is per-file; here we just insert a break.)
    addedLines.push(''); // blank separator so scans don't join across hunks
    continue;
  }
  if (!line.startsWith('+') || line.startsWith('+++')) continue;
  addedLines.push(line.slice(1));
}
flushFile();

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (offenders.length > 0) {
  console.error(`${LABEL} AC-23 VIOLATION -- feature diff (${sourceDesc}) adds ${offenders.length} write-side setter sugar export(s):`);
  for (const o of offenders) console.error(`  ${o}`);
  console.error(`${LABEL} A store export whose body is just gateway.dispatch(...) re-wraps the single door. Call gateway.dispatch directly (plan-strategy D-9 / AC-23).`);
  process.exit(1);
}

console.log(`${LABEL} AC-23 OK -- no new store setter sugar in diff (${sourceDesc})`);
process.exit(0);
