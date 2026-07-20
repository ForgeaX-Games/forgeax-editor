// m3-w2 — grep assertions for AC-03 (no UI setter bypass) and AC-08 (rename net)
//
// feat-20260706-editor-op-gateway-single-entry-b-catalog-defineop M3:
// Two machine-checked source-hygiene assertions that guard the "single entry"
// promise after the UI migration + rename:
//   AC-03  no UI handler calls a store setter directly — every state mutation
//          goes through gateway.dispatch / begin…commit. (setter direct calls in
//          the three UI packages must be zero.)
//   AC-08  no EditorBus / EditorCommand identifier survives anywhere in source —
//          the mechanical rename (M1) left no old name behind, and no compat
//          alias was reintroduced.
//
// FOOTGUN (research F3 / R6, plan-decisions leftover #3): the assertion MUST use
// a RECURSIVE glob (packages/**/src/** or a bare, pathspec-less scan). A
// non-recursive `packages/*/src` matches nothing under deeper paths and reports a
// FALSE zero. Verified on this platform additionally: `git grep -E` silently
// fails to honor `\b` word boundaries (git 2.50.1, macOS) — so we run with `-P`
// (PCRE), where `\b` works. Both pitfalls are pinned below.
//
// Constraints from upstream:
//   requirements AC-03: five-package source has no gateway-bypassing setter call
//   requirements AC-08: whole-repo grep for EditorBus/EditorCommand is zero
//   research F3 footgun: recursive glob, never packages/*/src
//   plan-strategy §4 R6: grep assertion command literals hardcode recursive glob
//
// Anchors:
//   plan-tasks.json m3-w2

import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Repo root: this file is at <root>/packages/core/src/__tests__/, four dirs up.
const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');

/**
 * Run `git grep` and return matching lines (empty array = zero hits).
 * Uses -P (PCRE) so \b word boundaries actually apply — git's default -E engine
 * silently ignores \b in an alternation on this platform (see header note).
 * git grep exits 1 with no output when there are no matches; that is success.
 */
function gitGrep(pattern: string, pathspecs: string[]): string[] {
  try {
    const out = execFileSync(
      'git',
      ['grep', '-nP', pattern, '--', ...pathspecs],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    return out.split('\n').filter((l) => l.trim().length > 0);
  } catch (e) {
    // Exit code 1 + empty stdout = no matches (the success case).
    const err = e as { status?: number; stdout?: string };
    if (err.status === 1 && !(err.stdout && err.stdout.trim())) return [];
    // Any other status (2 = real git error) or non-empty stdout on error: surface it.
    if (err.stdout && err.stdout.trim()) {
      return err.stdout.split('\n').filter((l) => l.trim().length > 0);
    }
    throw e;
  }
}

// The store setters that M3 seals into applier-private (their public form used to
// be callable directly from the UI). After migration the UI reaches every one of
// these only through gateway.dispatch({ kind: '<setter-as-op>' }).
const SEALED_SETTERS = [
  'setSelection',
  'setSelectionMany',
  'toggleSelection',
  'setGizmoMode',
  'setHoverEntity',
  'setFieldPreview',
  'setAssetSelection',
  'saveDocToDisk',
  'setSceneId',
  'requestFrame',
  'requestRename',
];

// The three UI packages (recursive globs — research F3 footgun: NOT packages/*/src).
const UI_GLOBS = [
  'packages/panels/src/**',
  'packages/content-browser/src/**',
  'packages/edit-runtime/src/**',
];

describe('AC-03 — no UI handler calls a sealed store setter directly (m3-w2)', () => {
  it('sealed setters appear only as op payloads, never as function calls, in UI source', () => {
    // Match a setter used as a CALL: `setSelection(` — precise, so a string
    // literal inside a dispatch payload (`kind: 'setSelection'`) never matches,
    // and no fragile "grep -v dispatch(" post-filter is needed.
    const callPattern = `\\b(${SEALED_SETTERS.join('|')})\\s*\\(`;
    const hits = gitGrep(callPattern, UI_GLOBS).filter((l) => !l.includes('.test.'));
    expect(hits).toEqual([]);
  });

  it('UI source does not import any sealed setter from editor-core', () => {
    // Belt-and-braces: after M3 seals the setters, importing one would be a
    // compile error — but assert it at the source level too so a regression is
    // caught as an AC-03 violation, not just a type error.
    const importPattern = `import[^;]*\\b(${SEALED_SETTERS.join('|')})\\b[^;]*from ['\"]@forgeax/editor-core['\"]`;
    const hits = gitGrep(importPattern, UI_GLOBS).filter((l) => !l.includes('.test.'));
    expect(hits).toEqual([]);
  });
});

describe('AC-08 — no EditorBus / EditorCommand identifier survives (m3-w2)', () => {
  it('whole-repo source + scripts are free of the old names', () => {
    // Exclude test files: this very file names EditorBus/EditorCommand in its
    // comments and in the grep pattern literal, so a tracked test file legitimately
    // references the forbidden identifiers. Production source is what AC-08 gates
    // (same .test. exclusion convention as AC-03). git grep searches tracked files
    // only, so once this file is committed it would otherwise match itself.
    const hits = gitGrep(
      '\\b(EditorBus|EditorCommand)\\b',
      ['packages/**/src/**', 'src/**', 'scripts/**'],
    ).filter((l) => !l.includes('.test.'));
    expect(hits).toEqual([]);
  });
});
