#!/usr/bin/env node
// lint-play-vag-boundary.mjs — play→core VAG-boundary gate
// (feat-20260705-editor-runtime-gates-and-backend-seams, w3).
//
// AGENTS.md invariant #5: play-runtime talks to editor-core ONLY through the
// VAG iframe protocol (`@forgeax/editor-core/protocol`).  This gate scans
// every .ts/.tsx in `packages/play-runtime/src/` and asserts that any
// non-type-only import whose specifier starts with `@forgeax/editor-core`
// uses the exact specifier `@forgeax/editor-core/protocol`.
//
// WHY REGEX, NOT AST
//   play-runtime is 6 files with 2 editor-core imports (research §D-6).
//   A statement-level regex reaches specifier-grade precision on this scan
//   surface without a new devDependency.  If negative tests expose false
//   positives (e.g. commented-out import literals), the upgrade path is
//   es-module-lexer without changing gate semantics.
//
// RULES
//   - `import type { X } from '…'`          → ALLOWED (type-only)
//   - `import { type X } from '…'`          → ALLOWED (all specifiers type-only)
//   - `import { type X, y } from '…'`       → GATED (mixed — y is a value import)
//   - `import { X } from '…'`               → GATED unless specifier === /protocol
//   - `import * as ns from '…'`             → GATED (value import)
//   - `import defaultExport from '…'`       → GATED (value import)
//   - `import '…'`                          → GATED (side-effect import)
//
//   Gate only fires when specifier startsWith `@forgeax/editor-core`.
//   Other specifiers are unrelated to the VAG boundary and pass through.
//
// Usage:   node scripts/lint-play-vag-boundary.mjs
// Exits    0 clean · 1 violations (listed on stderr) · 2 internal error.
//
// Plan anchors:
//   plan-strategy D-6 (statement-level regex, dep-cruiser double-insurance
//     rejected on SSOT grounds)
//   requirements AC-06 (import-specifier gate, exit 0/1, wired into lint)
//   requirements boundary-case #2 (type-only imports pass through)
// AC anchors: AC-06

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ROOT = resolve(__dirname, '..');
const PLAY_RUNTIME_SRC = resolve(EDITOR_ROOT, 'packages', 'play-runtime', 'src');

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function listSourceFiles(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc; // directory absent — nothing to scan
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.vite') continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      listSourceFiles(full, acc);
    } else if (/\.(ts|tsx)$/.test(name)) {
      acc.push(full);
    }
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Import-statement extraction (line-by-line, multi-line aware)
// ---------------------------------------------------------------------------

/**
 * @typedef {{ specifier: string, isTypeOnly: boolean, line: number }} ImportStmt
 */

/**
 * Parse a single file and return every import statement that references
 * `@forgeax/editor-core`.  Statements that cross multiple lines are
 * accumulated until the closing specifier is found.
 *
 * @param {string} text  — raw file text
 * @param {string} _file — file path (unused; reserved for error context)
 * @returns {ImportStmt[]}
 */
function extractEditorCoreImports(text, _file) {
  const lines = text.split('\n');
  /** @type {ImportStmt[]} */
  const result = [];

  let inImport = false;
  /** @type {string[]} */
  let buf = [];
  let startLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Strip // comments so commented-out import text doesn't trip the gate.
    const line = raw.replace(/\/\/.*$/, '');

    if (!inImport) {
      // Detect the start of an import statement.
      if (/^\s*import\s/.test(line)) {
        inImport = true;
        startLine = i + 1; // 1-indexed
        buf = [line];

        // Single-line imports: the line already contains `from '…'` or
        // is a side-effect import: `import '…'`.
        if (hasSpecifierClause(line)) {
          const stmt = classifyImport(buf.join(' '), startLine);
          if (stmt) result.push(stmt);
          inImport = false;
          buf = [];
        }
      }
      continue;
    }

    // Inside a multi-line import — accumulate.
    buf.push(line);

    // Once we see the `from '…'` clause the statement is complete.
    if (hasSpecifierClause(line)) {
      const stmt = classifyImport(buf.join(' '), startLine);
      if (stmt) result.push(stmt);
      inImport = false;
      buf = [];
    }
  }

  // Unclosed import (syntax error in source) — treat as non-import, skip.
  return result;
}

/** True when `line` contains a complete `from '…'` / `from "…"` clause
 *  OR is a side-effect import `import '…'` / `import "…"`. */
function hasSpecifierClause(line) {
  return /from\s+['"]/.test(line) || /import\s+['"]/.test(line);
}

/**
 * Classify a joined import-statement text.
 * Returns null when the specifier does NOT start with `@forgeax/editor-core`
 * (not our concern).
 */
function classifyImport(stmtText, line) {
  // ── extract the specifier ──────────────────────────────────────────
  const specifierMatch = stmtText.match(/from\s+['"]([^'"]+)['"]/);
  let specifier;
  if (specifierMatch) {
    specifier = specifierMatch[1];
  } else {
    // Side-effect import: `import '@forgeax/editor-core/…'`
    const sideMatch = stmtText.match(/import\s+['"]([^'"]+)['"]/);
    if (sideMatch) {
      specifier = sideMatch[1];
    } else {
      return null; // cannot parse — skip
    }
  }

  if (!specifier.startsWith('@forgeax/editor-core')) return null;

  // ── determine type-only status ─────────────────────────────────────
  const isTypeOnly = isImportStmtTypeOnly(stmtText);

  return { specifier, isTypeOnly, line };
}

/**
 * An import is type-only when ONE of these holds:
 *   (a) it starts with `import type`   — `import type { X } from '…'`
 *   (b) every specifier inside `{…}` is prefixed with `type`
 *       — `import { type X, type Y } from '…'`  (TS 4.5+ inline type imports)
 *
 * Mixed forms (`import { type X, y }`) are NOT type-only — `y` is a value
 * import and must pass the specifier check (boundary case #2).
 */
function isImportStmtTypeOnly(stmtText) {
  // (a) `import type …`
  if (/^\s*import\s+type\s/.test(stmtText)) return true;

  // (b) inline `type`-prefixed specifiers inside braces
  const braceMatch = stmtText.match(/\{([^}]*)\}/);
  if (!braceMatch) return false; // no braces → default / namespace import → not type-only

  const inside = braceMatch[1];
  const parts = inside.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((s) => /^type\s/.test(s));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const files = [];
  listSourceFiles(PLAY_RUNTIME_SRC, files);

  if (files.length === 0) {
    console.error('lint-play-vag-boundary: no source files found in play-runtime/src/');
    process.exit(2);
  }

  /** @type {{ file: string, line: number, specifier: string }[]} */
  const violations = [];

  for (const absPath of files) {
    const text = readFileSync(absPath, 'utf8');
    const imports = extractEditorCoreImports(text, absPath);

    for (const imp of imports) {
      // Type-only imports are always allowed.
      if (imp.isTypeOnly) continue;

      // Value imports: specifier must be precisely /protocol.
      if (imp.specifier !== '@forgeax/editor-core/protocol') {
        violations.push({
          file: relative(EDITOR_ROOT, absPath),
          line: imp.line,
          specifier: imp.specifier,
        });
      }
    }
  }

  if (violations.length > 0) {
    console.error(
      `\n✗ play→core VAG-boundary gate: ${violations.length} violation(s).\n` +
      `  Non-type-only play-runtime imports from @forgeax/editor-core must\n` +
      `  use the exact specifier '@forgeax/editor-core/protocol' (the VAG\n` +
      `  iframe-protocol channel).  Type-only imports are exempt.\n`,
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  specifier="${v.specifier}"`);
    }
    console.error('');
    process.exit(1);
  }

  console.log(
    `✓ play→core VAG-boundary gate: all play-runtime→core imports ` +
    `are /protocol only (${files.length} files scanned).`,
  );
}

try {
  main();
} catch (err) {
  console.error('lint-play-vag-boundary: internal error:', err);
  process.exit(2);
}