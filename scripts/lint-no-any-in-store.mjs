#!/usr/bin/env node
// lint-no-any-in-store.mjs — AC-06 any-gate: mechanical ': any' detector
// for packages/core/src/store/**/*.ts
//
// Every `: any` in the store/ directory (including comments and string
// literals, per requirements boundary #4: "appearance is block") trips CI.
// This is an absolute gate — no exclusions, no known-region whitelist (#47
// lesson: judge symbol appearance, not known intervals). The baseline is 0
// hits across the two existing files (store.ts + entity-state.ts) and stays
// at 0 for every new sub-module added during store decomposition.
//
// plan-strategy D-8 · plan-strategy §5.4 falsification check ③
//
// Usage:   node scripts/lint-no-any-in-store.mjs
// Exits    0 clean · 1 violations (listed on stderr) · 2 internal error.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ROOT = resolve(__dirname, '..');

// The store/ directory under core.
const STORE_DIR = resolve(EDITOR_ROOT, 'packages', 'core', 'src', 'store');

// Regex: `: any` — matches `:any`, `: any`, `:  any`, `:	 any`, etc.
// The \b after `any` avoids matching `anything` / `anywhere` substrings.
const ANY_COLON = /:\s*any\b/;

function listSourceFiles(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc; // dir absent — nothing to scan
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.vite') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      listSourceFiles(full, acc);
    } else if (/\.(ts|tsx|mts|cts)$/.test(name)) {
      acc.push(full);
    }
  }
  return acc;
}

function main() {
  const files = listSourceFiles(STORE_DIR, []);

  if (files.length === 0) {
    console.error('lint-no-any-in-store: no source files found in', STORE_DIR);
    process.exit(2);
  }

  const violations = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (ANY_COLON.test(lines[i])) {
        violations.push({
          file: relative(EDITOR_ROOT, file),
          line: i + 1,
          text: lines[i].trim(),
        });
      }
    }
  }

  if (violations.length > 0) {
    console.error(
      `\n✗ AC-06 any-gate: ${violations.length} ': any' hit(s) in store/ source.\n` +
        `  Replace ': any' with an explicit type or use 'unknown' + narrowing.\n`,
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.text}`);
    }
    console.error('');
    process.exit(1);
  }

  console.log(
    `✓ AC-06 any-gate: no ': any' in store/ source (${files.length} file(s) scanned).`,
  );
}

try {
  main();
} catch (err) {
  console.error('lint-no-any-in-store: internal error:', err);
  process.exit(2);
}