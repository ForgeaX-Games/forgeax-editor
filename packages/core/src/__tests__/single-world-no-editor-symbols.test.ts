// single-world-no-editor-symbols.test.ts — AC-16 / AC-17 structural guard
// (feat-20260630-viewport-2x2-run-x-display-redesign, w28).
//
// WHY THIS EXISTS
//   The single-world model (requirements C-1) is the load-bearing invariant of
//   this feature: editor and game systems share ONE edit-runtime world, gated by
//   `notEditing` (w10) and flipped by injectEditMode (w11). Two red lines protect
//   it from silent erosion:
//     AC-16 — the engine layer carries ZERO editor concepts (an engine that knows
//             about "editor cameras" or "edit mode" has leaked the seam).
//     AC-17 — no world-splitting: no `EditorOnly` marker, no second world built in
//             a production code path, no save/hierarchy/snapshot path that filters
//             out "editor entities" with a special case.
//
//   A grep/test gate is the only thing that keeps a future refactor from quietly
//   reintroducing a second world or an `if (entity.isEditor)` skip — both look
//   locally reasonable and pass every other test.
//
// SCOPE & METHOD (filesystem scan — hermetic, no git, no submodule traversal)
//   Production source ONLY: test files (*.test.ts, *.test-d.ts, __tests__/) are
//   excluded because unit fixtures legitimately spin up throwaway worlds.
//     - engine layer       → packages/engine/packages/*/src  (AC-16 + AC-17 world)
//     - editor-core        → editor-core/src                 (AC-17 world + filter)
//     - edit-runtime       → edit-runtime/src                (AC-17 world + filter)
//   The diff-scoped `git merge-base` gate in plan-tasks.json M2 milestoneCISweep
//   is the COMPLEMENTARY runtime check (it tracks net-new world constructions in
//   the engine diff); this test is the absolute structural floor.
//
// Style anchor: barrel-export-contract.test.ts (glob-discovered, source-parsed).

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// core/src/__tests__ → ../../.. = packages/
const PKGS_ROOT = join(import.meta.dir, '..', '..', '..');

const EXCLUDE = /(__tests__|\.test\.|\.test-d\.|node_modules|dist|\.vite|broken-syntax|[/\\]fixtures[/\\]|\.d\.ts$)/;

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // dir may not be checked out (e.g. shallow engine) — skip
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (EXCLUDE.test(p)) continue;
    const s = statSync(p);
    if (s.isDirectory()) out = out.concat(walk(p));
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

// Engine layer is a nested submodule with a per-package `src` layout
// (packages/engine/packages/<pkg>/src). Discover every such src root.
function engineSrcFiles(): string[] {
  const engPkgs = join(PKGS_ROOT, 'engine', 'packages');
  if (!existsSync(engPkgs)) return [];
  let out: string[] = [];
  for (const pkg of readdirSync(engPkgs)) {
    out = out.concat(walk(join(engPkgs, pkg, 'src')));
  }
  return out;
}

const EDITOR_LAYER_FILES = [
  ...walk(join(PKGS_ROOT, 'core', 'src')),
  ...walk(join(PKGS_ROOT, 'edit-runtime', 'src')),
];

const ENGINE_FILES = engineSrcFiles();

// Strip line comments and block comments so prose anchors (which legitimately
// mention "EditMode" / "editor camera" to explain the seam) don't trip a grep
// meant for actual identifiers/strings in code.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('AC-16 — engine layer carries zero editor concepts', () => {
  test('sanity: engine + editor source discovered', () => {
    expect(EDITOR_LAYER_FILES.length).toBeGreaterThan(20);
    // Engine is a shallow nested submodule; if absent the scan is a no-op rather
    // than a false pass — flag it so the gate failure is legible.
    if (ENGINE_FILES.length === 0) {
      console.warn('[w28] engine submodule src not found — AC-16 engine scan skipped');
    }
  });

  // Editor concepts that must never appear in engine code. ActiveCamera is the
  // engine-NEUTRAL mechanism (w12) — it is an entity-id resource, NOT an editor
  // concept — so it is intentionally NOT in this list.
  const EDITOR_SYMBOLS = /\b(EditorOnly|EditorCamera|editMode|EditMode|isEditor|notEditing|injectEditMode)\b/;

  for (const file of ENGINE_FILES) {
    const rel = file.slice(PKGS_ROOT.length + 1);
    test(`engine ${rel} has no editor symbol`, () => {
      const code = stripComments(readFileSync(file, 'utf8'));
      const m = code.match(EDITOR_SYMBOLS);
      expect(m ? `${rel}: editor symbol '${m[0]}'` : null).toBeNull();
    });
  }
});

describe('AC-17 — no world split (one world, no EditorOnly, no editor-entity filter)', () => {
  const ALL_PRODUCTION = [...ENGINE_FILES, ...EDITOR_LAYER_FILES];

  test('zero EditorOnly marker anywhere in production source', () => {
    const hits: string[] = [];
    for (const file of ALL_PRODUCTION) {
      const code = stripComments(readFileSync(file, 'utf8'));
      if (/\bEditorOnly\b/.test(code)) hits.push(file.slice(PKGS_ROOT.length + 1));
    }
    expect(hits).toEqual([]);
  });

  // NOTE on the "no second world" half of AC-17:
  //   The net-new-world assertion is DIFF-SCOPED, not absolute. Legitimate editor
  //   `new World()` sites exist (play mode's transient playWorld; historically the
  //   now-removed open-project.ts M3 proof-of-life sidecar), so an absolute
  //   `count == 0` would be the stale literal the plan explicitly rejects. The canonical AC-17 world-split gate
  //   is the diff-scoped `git merge-base HEAD origin/main; $base...HEAD …` command
  //   in plan-tasks.json M2 milestoneCISweep (engine layer) — kept there because a
  //   diff against origin/main is unreliable inside a hermetic bun test on a
  //   shallow nested submodule clone. This file owns the ABSOLUTE invariants
  //   (no EditorOnly marker, no editor symbol in engine, no editor-entity filter);
  //   the sweep owns the DIFF-SCOPED net-new-world invariant.

  test('save/hierarchy/snapshot paths have no editor-entity filter special-case', () => {
    // The anti-pattern: branching projection/save/hierarchy logic on whether an
    // entity is "an editor entity" (e.g. `if (entity.isEditor)` / `.isEditorEntity`
    // / a `skipEditor`/`filterEditor` guard). The single-world model forbids it —
    // editor helper entities are plain world entities, not a filtered class.
    const FILTER = /\b(isEditorEntity|skipEditorEntit|filterEditorEntit)\w*\b|\bentity\.isEditor\b|\.isEditor\s*[)&|=?]/;
    const hits: string[] = [];
    for (const file of ALL_PRODUCTION) {
      const code = stripComments(readFileSync(file, 'utf8'));
      const m = code.match(FILTER);
      if (m) hits.push(`${file.slice(PKGS_ROOT.length + 1)}: '${m[0]}'`);
    }
    expect(hits).toEqual([]);
  });
});
