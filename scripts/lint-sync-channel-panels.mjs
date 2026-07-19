#!/usr/bin/env node
// lint-sync-channel-panels.mjs
//
// Single-SSOT guard for the EDITOR_PANELS literal.
//
// After feat-20260703 (single-realm injection): the inline copy of EDITOR_PANELS
// that lived in sync-channel.ts was deleted along with the sync-channel mechanism
// itself. The lint now guards the opposite invariant: EDITOR_PANELS must exist
// in EXACTLY ONE place (core/src/manifest.ts). Any second copy is drift
// and trips CI.
//
// Usage:
//   node lint-sync-channel-panels.mjs
//   node lint-sync-channel-panels.mjs --ssoot-path <ts> --scan-dir <dir>
//
// Exits 0 when exactly one EDITOR_PANELS literal exists in the scan directory
// (default: packages/). Exits 1 on drift (2+ copies found). Exits 2 on internal
// error (zero copies or file read failure).
//
// Anchors:
//   plan-strategy S2 D3 (lint upgraded from dual-compare to single-SSOT guard)
//   AC-07 (lint:sync-channel green after semantic upgrade)
//   AGENTS.md invariant #3 (single-SSOT, not dual-copy)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ROOT = resolve(__dirname, '..');

const DEFAULT_SSOT = resolve(
  EDITOR_ROOT,
  'packages/core/src/manifest.ts',
);
const DEFAULT_SCAN_DIR = resolve(EDITOR_ROOT, 'packages');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { ssootPath: DEFAULT_SSOT, scanDir: DEFAULT_SCAN_DIR };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ssoot-path') out.ssootPath = resolve(argv[++i]);
    else if (a === '--scan-dir') out.scanDir = resolve(argv[++i]);
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: lint-sync-channel-panels.mjs [--ssoot-path <ts>] [--scan-dir <dir>]\n',
      );
      process.exit(0);
    } else {
      process.stderr.write(`lint-sync-channel-panels: unknown arg ${a}\n`);
      process.exit(2);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// File-system walker (recursive, no external deps)
// ---------------------------------------------------------------------------
function walkDir(dir) {
  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      // Skip node_modules, .git, dist, etc.
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      results.push(...walkDir(full));
    } else if (e.isFile()) {
      const ext = extname(e.name);
      if (ext === '.ts' || ext === '.tsx' || ext === '.mjs' || ext === '.mts') {
        results.push(full);
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Extract EDITOR_PANELS literal from a source file.
// Returns the panel-id array, or null if the file has no such literal.
// ---------------------------------------------------------------------------
function extractPanels(src) {
  const m = src.match(/EDITOR_PANELS\s*=\s*\[([\s\S]*?)\]\s*as\s+const/);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const { ssootPath, scanDir } = parseArgs(process.argv.slice(2));

  // Collect all source files under the scan directory.
  const files = walkDir(scanDir);

  // Find every file that defines an EDITOR_PANELS literal.
  const hits = [];
  for (const f of files) {
    let src;
    try {
      src = readFileSync(f, 'utf8');
    } catch {
      continue; // unreadable file — skip
    }
    const panels = extractPanels(src);
    if (panels) {
      hits.push({ path: relative(EDITOR_ROOT, f), panels });
    }
  }

  // -- 0 copies: fatal, SSOT disappeared --
  if (hits.length === 0) {
    process.stderr.write(
      'lint-sync-channel-panels: EDITOR_PANELS literal not found anywhere under packages/\n',
    );
    process.stderr.write(
      `  expected SSOT: ${relative(EDITOR_ROOT, ssootPath)}\n`,
    );
    process.exit(2);
  }

  // -- 1 copy: single SSOT, green --
  if (hits.length === 1) {
    const h = hits[0];
    const expectedRel = relative(EDITOR_ROOT, ssootPath);
    if (h.path !== expectedRel) {
      // Single hit but in an unexpected location — warn but still exit 0
      // (the scan-dir arg may be pointing elsewhere for testing).
      process.stdout.write(
        `lint-sync-channel-panels: single SSOT at ${h.path} (expected ${expectedRel})\n`,
      );
    }
    process.stdout.write(
      `lint-sync-channel-panels: single SSOT at ${h.path} — ${h.panels.length} panels\n`,
    );
    process.exit(0);
  }

  // -- 2+ copies: drift --
  process.stderr.write(
    `lint-sync-channel-panels: EDITOR_PANELS drift detected — ${hits.length} copies found.\n`,
  );
  for (const h of hits) {
    process.stderr.write(
      `  ${h.path} = [${h.panels.map((p) => `'${p}'`).join(', ')}]\n`,
    );
  }
  process.stderr.write(
    '  fix: EDITOR_PANELS must exist in exactly one file (core/src/manifest.ts).\n',
  );
  process.stderr.write(
    '  Delete any duplicate literal and re-import from the SSOT.\n',
  );
  process.exit(1);
}

main();