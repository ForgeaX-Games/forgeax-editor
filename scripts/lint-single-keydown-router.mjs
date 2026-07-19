#!/usr/bin/env node
// lint-single-keydown-router.mjs -- Gate (keyboard-router convergence M4 T4-4,
// plan-strategy G-1 / AC-A1): there must be EXACTLY ONE global keyboard listener
// for editor shortcuts — the one in interface's useGlobalShortcuts (capture-phase
// window keydown). Every other `window.addEventListener('keydown', …)` /
// `document.addEventListener('keydown', …)` is a scattered global keydown hook that
// re-introduces the feedback's "CB hijacks keys from other panels" bug.
//
// LEVEL 1 (global keydown封窗): any diff-added line that registers a keydown
// listener on `window` or `document` is a VIOLATION. This is the hard gate.
//
// LEVEL 2 (JSX onKeyDown 自由): inline `onKeyDown={…}` JSX attributes are
// naturally scoped to an element subtree, NOT a global hook, so they are NOT
// flagged (AC-A3 level 2 — no white-list discipline layer needed).
//
// DIFF-SCOPED (following lint-unique-mutator.mjs / lint-op-via-gateway.mjs):
//   Only NET-NEW added `+` lines are checked, so pre-existing listeners (viewport
//   onKey, DeleteGuardDialog, useGlobalShortcuts itself) are not re-flagged on
//   every unrelated PR. The gate holds the line going forward.
//
// EXCLUSIONS:
//   - engine submodule (packages/engine/**) — not editor source
//   - test hunks (__tests__/ + *.test.*)
//   - comment-only lines
//
// EXIT CODES: 0 clean / 1 violation / 2 cannot determine base (refuse to pass blind)

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const LABEL = '[lint-single-keydown-router]';

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

// A global keydown hook: addEventListener('keydown' | "keydown") on window or
// document. Matches `window.addEventListener('keydown', …)`,
// `document.addEventListener("keydown", …)`, and the capture-phase forms.
const GLOBAL_KEYDOWN_RE = /\b(?:window|document)\s*\.addEventListener\(\s*['"]keydown['"]/;

const ENGINE_SUBMODULE_RE = /packages\/engine\//;
const TEST_HUNK_RE = /(__tests__|\.test\.|\.test-d\.)/;

function isExcludedFile(file) {
  if (ENGINE_SUBMODULE_RE.test(file)) return true;
  if (TEST_HUNK_RE.test(file)) return true;
  return false;
}

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

for (const line of diffText.split('\n')) {
  if (line.startsWith('+++ b/')) {
    curFile = line.slice('+++ b/'.length);
    curFileExcluded = isExcludedFile(curFile);
    continue;
  }
  if (!line.startsWith('+') || line.startsWith('+++')) continue;
  if (curFileExcluded) continue;

  const added = line.slice(1);
  if (isCommentLine(added)) continue;

  if (GLOBAL_KEYDOWN_RE.test(added)) {
    offenders.push(`${curFile}: ${added.trim()}`);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (offenders.length > 0) {
  console.error(`${LABEL} G-1 / AC-A1 VIOLATION -- feature diff (${sourceDesc}) adds ${offenders.length} global keydown listener(s) outside the single router:`);
  for (const o of offenders) console.error(`  ${o}`);
  console.error(`${LABEL} All editor keyboard shortcuts must register in interface's global-shortcuts.ts (the one useGlobalShortcuts listener). No other window/document keydown hook is allowed (JSX onKeyDown is fine — naturally scoped).`);
  process.exit(1);
}

console.log(`${LABEL} AC-A1 OK -- no new global keydown listeners outside the single router in diff (${sourceDesc})`);
process.exit(0);
