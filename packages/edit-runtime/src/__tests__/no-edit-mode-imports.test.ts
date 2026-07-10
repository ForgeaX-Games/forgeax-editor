// no-edit-mode-imports.test.ts (w30) — AC-10 editor-side source guardrail.
//
// feat-20260709-editor-world-partition-editorworld-super-composite / M6.
//
// AC-10: once editorWorld is forked from sceneWorld (M4) and the freeze domain is
// decoupled, the `EditMode` resource + `notEditing` run-condition lose their
// purpose — editorWorld is NEVER frozen, and game systems simply do not tick in
// edit mode because they are structurally absent from the edit-mode active
// schedule (D-7: registration-surface removal REPLACES "register + notEditing
// gate"). This test is the REGRESSION GUARDRAIL — it greps the editor assembly
// source (edit-runtime/src + core/src) and asserts:
//   (1) zero `injectEditMode` import/call in editor assembly source (the resource
//       injection is gone — ViewportComponent no longer flips EditMode).
//   (2) zero `notEditing` import/call in editor assembly source (the discoverer no
//       longer gates game systems on a run-condition; game systems tick freely in
//       the world they are registered into, and edit mode simply never registers
//       them into an active-ticking schedule — play-assemble is the same-shape
//       precedent: game systems tick without a notEditing gate).
//   (3) zero `EditMode` resource key injection (`insertResource('EditMode'` /
//       `"EditMode"`) in editor assembly source.
//
// SCOPE — production assembly source ONLY (edit-runtime/src + core/src), tests
// excluded (unit fixtures may still exercise historical helpers during the same
// process; this gate targets the shipped assembly path). This is COMPLEMENTARY to
// single-world-no-editor-symbols.test.ts, which scans the ENGINE layer for editor
// symbols (research F6): that test's EDITOR_SYMBOLS loop runs over ENGINE_FILES
// only, so this editor-layer clearance does not touch it — verified in F6.
//
// Anchors:
//   requirements AC-10 (editor assembly source no longer imports/injects
//     injectEditMode / notEditing; single-world test keeps its current scope + green)
//   plan-strategy §2 D-7 (S8 clearance: injectEditMode + notEditing gate removed,
//     game-systems registration-surface removal; edit-mode.ts deleted, core -1)
//   research F6 (inject 1 site / consume 1 site; clearance boundary is clean;
//     single-world test scans engine layer only, editor clearance does not trip it)

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// edit-runtime/src/__tests__ → ../.. = edit-runtime/src ; then hop to core/src.
const EDIT_RUNTIME_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// packages/edit-runtime/src → ../../../core/src = packages/core/src
const CORE_SRC = resolve(EDIT_RUNTIME_SRC, '..', '..', 'core', 'src');

/** Every .ts/.tsx file under a src root, excluding tests + fixtures. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'fixtures' || name === 'node_modules') continue;
      out.push(...sourceFiles(full));
    } else if (
      (name.endsWith('.ts') || name.endsWith('.tsx')) &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.test-d.ts') &&
      !name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Strip // line comments and block comments so a prose anchor that legitimately
 *  mentions `injectEditMode` / `notEditing` / `EditMode` to explain the *removed*
 *  seam (e.g. play-assemble.ts's "no notEditing gate" comment) is not a false
 *  positive. This gate targets real identifiers/strings in code, not prose. */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');
}

const FILES = [...sourceFiles(EDIT_RUNTIME_SRC), ...sourceFiles(CORE_SRC)];

function offendersMatching(re: RegExp): string[] {
  const hits: string[] = [];
  for (const f of FILES) {
    const code = stripComments(readFileSync(f, 'utf8'));
    // fresh RegExp per file so the /g lastIndex does not leak across iterations.
    if (new RegExp(re.source, re.flags).test(code)) {
      hits.push(f.replace(/^.*\/packages\//, 'packages/'));
    }
  }
  return hits;
}

describe('w30 — AC-10 editor assembly source is free of injectEditMode/notEditing/EditMode', () => {
  it('sanity: editor assembly source discovered (non-vacuous scan)', () => {
    // Guard against a broken path silently emptying the scan → false green.
    expect(FILES.length).toBeGreaterThan(20);
  });

  it('has zero injectEditMode import/call in editor assembly source', () => {
    expect(offendersMatching(/\binjectEditMode\b/)).toEqual([]);
  });

  it('has zero notEditing import/call in editor assembly source', () => {
    expect(offendersMatching(/\bnotEditing\b/)).toEqual([]);
  });

  it('has zero EditMode resource key injection in editor assembly source', () => {
    // The freeze resource is gone: no EDIT_MODE_KEY symbol, no insertResource of
    // an 'EditMode' key, no EditModeState type reference.
    expect(offendersMatching(/\bEDIT_MODE_KEY\b/)).toEqual([]);
    expect(offendersMatching(/\bEditModeState\b/)).toEqual([]);
    expect(offendersMatching(/insertResource\s*\(\s*['"]EditMode['"]/)).toEqual([]);
  });
});
