#!/usr/bin/env node
// lint-readme-bilingual.mjs — README bilingual-gate
// (feat-20260705-editor-runtime-gates-and-backend-seams, w4).
//
// AGENTS.md invariant #6: README.md and README.zh-CN.md must stay in sync.
// This gate asserts two properties:
//   (a) Existence   — both files must be present.
//   (b) Chapter     — the number of `^## ` chapters must be equal, and their
//       order must match (anchored by untranslated titles `known limitations`
//       and `troubleshooting`).
//
// WHY COUNT + ORDER, NOT FULL-TEXT COMPARISON
//   Titles have been translated (Packages vs Chinese equivalents).  Checking for exact
//   text equality would false-positive on every Chinese title.  We require
//   count equality as the minimum enforcement and use the two untranslated
//   anchor titles (known limitations / troubleshooting) as order anchors;
//   translated titles are not text-asserted (boundary case #3).  When both
//   anchors are absent (full translation in the future), the gate degrades
//   to pure count equality — it will not false-positive on translation
//   progress (D-7).
//
// WHAT IS NOT CHECKED
//   - Line-count tolerance (en/zh naturally differ: 79vs75, 158vs152, 174vs165).
//     This is deliberately OOS (OOS-8).
//   - Text equality of translated titles (seq 1-4: en titles vs their Chinese equivalents).
//
// Usage:   node scripts/lint-readme-bilingual.mjs
// Exits    0 clean · 1 violations (listed on stderr) · 2 internal error.
//
// Plan anchors:
//   plan-strategy D-7 (count + untranslated-anchor order, no line-count tolerance)
//   requirements AC-07 (existence + chapter count+order gate)
//   requirements boundary-case #3 (translated titles not text-asserted)
// AC anchors: AC-07

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ROOT = resolve(__dirname, '..');

const README_EN      = resolve(EDITOR_ROOT, 'README.md');
const README_ZH      = resolve(EDITOR_ROOT, 'README.zh-CN.md');

// Anchor titles whose chapter indices must match in both files.
// knownLimitations uses prefix match to tolerate en/zh bracket differences:
//   en: `known limitations (baseline as of 2026-06-13)`
//   zh: `known limitations (baseline as of 2026-06-13)` (with Chinese parentheses)
const ANCHOR_KNOWN_LIM = /^known limitations\b/i;
const ANCHOR_TROUBLESHOOTING = /^troubleshooting$/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract `^## ` chapter lines from a file.
 * Returns `{ raw: string[], indices: number[] }` where `indices` is the
 * 0-based line number of each `^## ` heading in the original file.
 */
function extractChapters(text) {
  const chapters = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^## (.+)/);
    if (m) {
      chapters.push({ title: m[1].trim(), index: i });
    }
  }
  return chapters;
}

/**
 * Locate the 0-based chapter index of an anchor in a chapters array.
 * Returns -1 when not found.
 */
function findAnchor(chapters, regex) {
  for (let i = 0; i < chapters.length; i++) {
    if (regex.test(chapters[i].title)) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Order verification via anchor titles (D-7)
// ---------------------------------------------------------------------------

/**
 * Verify chapter order via anchor titles.
 * Returns an array of error-description strings (empty when aligned).
 */
function verifyOrder(enChapters, zhChapters) {
  const enKlIdx = findAnchor(enChapters, ANCHOR_KNOWN_LIM);
  const zhKlIdx = findAnchor(zhChapters, ANCHOR_KNOWN_LIM);
  const enTsIdx = findAnchor(enChapters, ANCHOR_TROUBLESHOOTING);
  const zhTsIdx = findAnchor(zhChapters, ANCHOR_TROUBLESHOOTING);

  const errors = [];
  const checkAnchor = (label, enIdx, zhIdx) => {
    if (enIdx !== -1 || zhIdx !== -1) {
      if (enIdx !== zhIdx) {
        const e = enIdx >= 0 ? enIdx + 1 : 'NOT FOUND';
        const z = zhIdx >= 0 ? zhIdx + 1 : 'NOT FOUND';
        errors.push(`  "${label}" anchor mismatch: EN chapter ${e}, ZH chapter ${z}`);
      }
    }
  };
  checkAnchor('known limitations', enKlIdx, zhKlIdx);
  checkAnchor('troubleshooting', enTsIdx, zhTsIdx);

  return { errors, enKlIdx, enTsIdx };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // ── (a) Existence ────────────────────────────────────────────────────
  let enText, zhText;
  try {
    enText = readFileSync(README_EN, 'utf8');
  } catch {
    console.error('\n✗ README bilingual gate: README.md not found.\n');
    process.exit(1);
  }
  try {
    zhText = readFileSync(README_ZH, 'utf8');
  } catch {
    console.error('\n✗ README bilingual gate: README.zh-CN.md not found.\n');
    process.exit(1);
  }

  // ── (b) Chapter count + order ────────────────────────────────────────
  const enChapters = extractChapters(enText);
  const zhChapters = extractChapters(zhText);

  // Pure count equality — the minimum enforcement.
  if (enChapters.length !== zhChapters.length) {
    console.error(
      `\n✗ README bilingual gate: chapter count mismatch.\n` +
      `  README.md:           ${enChapters.length} chapters\n` +
      `  README.zh-CN.md:     ${zhChapters.length} chapters\n\n` +
      enChapters.map((c, i) => `  [${i + 1}] ${c.title}`).join('\n') +
      '\n\n  vs\n\n' +
      zhChapters.map((c, i) => `  [${i + 1}] ${c.title}`).join('\n') +
      '\n',
    );
    process.exit(1);
  }

  // Order check via anchor titles (D-7).
  // When neither anchor is present, order check degrades to pure count
  // equality — gate does not false-positive on translation progress.
  const { errors: orderErrors, enKlIdx, enTsIdx } = verifyOrder(enChapters, zhChapters);

  if (orderErrors.length > 0) {
    console.error(
      `\n✗ README bilingual gate: chapter order mismatch.\n` +
      orderErrors.join('\n') +
      '\n\n  EN chapters:\n' +
      enChapters.map((c, i) => `    [${i + 1}] ${c.title}`).join('\n') +
      '\n\n  ZH chapters:\n' +
      zhChapters.map((c, i) => `    [${i + 1}] ${c.title}`).join('\n') +
      '\n',
    );
    process.exit(1);
  }

  console.log(
    `✓ README bilingual gate: both files present, ` +
    `${enChapters.length} chapters each, order aligned` +
    (enKlIdx >= 0 ? ` (known limitations @${enKlIdx + 1}, troubleshooting @${enTsIdx >= 0 ? enTsIdx + 1 : 'N/A'})` : '') +
    '.',
  );
}

try {
  main();
} catch (err) {
  console.error('lint-readme-bilingual: internal error:', err);
  process.exit(2);
}