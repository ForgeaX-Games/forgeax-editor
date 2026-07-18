#!/usr/bin/env node
// lint-no-direct-pack-crud.mjs — D4 gate: pack CRUD must go through
// gateway.dispatch() or ctx.assetIO seam, not bare function calls.
//
// Matches bare calls to createPack / addAssetToPack / removeAssetFromPack /
// duplicateAssetInPack / moveAsset in content-browser and panels source.
// White-lists pack-ops.ts (the applier) and asset-io-facade.ts (the gate seam).
//
// WHY DIFF-SCOPED: Only flags net-new lines in the feature diff (same pattern
// as lint-op-via-gateway.mjs). Pre-existing violations are exempt (grandfathered).
//
// EXIT CODES: 0 clean / 1 violation / 2 cannot determine base

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------
function git(args) {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' }).trim();
}
function gitSafe(args) {
  try { return git(args); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Resolve base ref (same strategy as lint-op-via-gateway.mjs)
// ---------------------------------------------------------------------------
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
// Get diff
// ---------------------------------------------------------------------------
const baseRef = resolveBaseRef();
if (baseRef === null) {
  console.error('[lint-no-direct-pack-crud] cannot resolve diff base — refusing to pass blind');
  process.exit(2);
}

// Compute diff range. Prefer 3-dot (merge-base...HEAD) for accurate feature
// diff; fall back to 2-dot (base..HEAD) when no common ancestor (shallow CI
// checkout of a brand-new branch). Either way we diff against the base ref.
let diffText = null;
let range = null;
const mb = gitSafe(['merge-base', 'HEAD', baseRef]);
if (mb) {
  range = `${mb}...HEAD`;
  diffText = gitSafe(['diff', range, '--', '*.ts', '*.tsx']);
}
if (diffText === null) {
  // Fall back to 2-dot range (no merge-base needed)
  range = `${baseRef}..HEAD`;
  diffText = gitSafe(['diff', range, '--', '*.ts', '*.tsx']);
}
if (diffText === null) {
  console.error(`[lint-no-direct-pack-crud] git diff failed for range ${range} — refusing to pass blind`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

// Pack CRUD function calls we guard against (bare call, not via ctx.assetIO)
// Negative lookbehind: skip calls prefixed with assetIO. or ctx.assetIO.
const PACK_CRUD_RE = /(?<!assetIO\.)(?<!ctx\.assetIO\.)\b(createPack|addAssetToPack|removeAssetFromPack|duplicateAssetInPack|moveAsset)\s*\(/;

// White-listed files (applier + gate seam)
const WHITELIST = new Set([
  'packages/core/src/session/pack-ops.ts',
  'packages/core/src/io/asset-io-facade.ts',
]);

// Only flag in UI panels (content-browser / panels src) plus any non-whitelisted core
// that isn't the applier or facade.
const TARGET_PATH_RE = /packages\/(content-browser|panels|edit-runtime)\/src\//;

// Test hunk exemption
const TEST_HUNK_RE = /(__tests__|\.test\.|\.test-d\.)/;

// Parse diff hunks
const lines = diffText.split('\n');
const violations = [];
let currentFile = null;

for (const line of lines) {
  // Track current file from diff header
  const hdrMatch = line.match(/^\+\+\+\s+b\/(.*)/);
  if (hdrMatch) {
    currentFile = hdrMatch[1];
    continue;
  }

  // Only process added lines
  if (!line.startsWith('+') || line.startsWith('+++')) continue;

  // Skip test hunks
  if (currentFile && TEST_HUNK_RE.test(currentFile)) continue;

  // Skip whitelisted files
  if (currentFile && WHITELIST.has(currentFile)) continue;

  // Only flag in UI packages
  if (currentFile && !TARGET_PATH_RE.test(currentFile)) continue;

  // Check for bare pack CRUD calls
  const match = line.match(PACK_CRUD_RE);
  if (match) {
    violations.push(`${currentFile}: bare ${match[1]}() call — pack CRUD must go through gateway.dispatch() or ctx.assetIO seam`);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (violations.length > 0) {
  console.error(`\n[lint-no-direct-pack-crud] VIOLATION — diff adds ${violations.length} bare pack CRUD call(s):`);
  for (const v of violations) {
    console.error(`  ${v}`);
  }
  console.error(`\n  Pack writes must go through:\n    • gateway.dispatch({ kind:'createAsset' | 'destroyAsset' | ... })\n    • ctx.assetIO seam (applier-internal)\n  Bare createPack / addAssetToPack / removeAssetFromPack / duplicateAssetInPack / moveAsset calls are forbidden in UI panels.\n`);
  process.exit(1);
}

console.log('[lint-no-direct-pack-crud] OK — no new bare pack CRUD calls in diff.');
process.exit(0);
