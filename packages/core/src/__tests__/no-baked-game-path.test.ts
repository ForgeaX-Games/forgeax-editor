// no-baked-game-path.test.ts — regression guard for the layout decoupling
// (feedback 2026-06-25-editor-bakes-game-path-convention).
//
// HARD REQUIREMENT: the ENTIRE editor holds ZERO host disk-layout convention.
// The games-directory layout is each HOST's concern (standalone / studio),
// injected via setPathResolver (`?gameRoot=`), the EditSurface `gameRoot` prop,
// and the play-runtime FORGEAX_PREVIEW_GAMES_DIR / FORGEAX_GAMES_URL_PREFIX env —
// never baked into a string literal (or comment) in editor source. dependency-
// cruiser guards the package DAG but cannot see string literals; this red-line
// fills that gap (the feedback's Layer 3 ②).
//
// If this fails: you (re)introduced a `.forgeax/games` literal in editor source.
// Route it through the injection seam instead and let the host own the layout.

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// core/src/__tests__ → ../../.. = packages/
const PKGS_ROOT = join(import.meta.dir, '..', '..', '..');

// ALL editor packages — pure libs AND runtime/host adapters. The convention
// lives in the hosts (standalone/studio), NOT anywhere in editor source.
const PURE_LIB_ROOTS = [
  'core/src', 'content-browser/src',
  'edit-runtime/src', 'panels/src', 'play-runtime/src',
];

const EXCLUDE = /(__tests__|\.test\.|node_modules|broken-syntax|[/\\]fixtures[/\\])/;

// The exact coupling we removed. A re-introduced literal anywhere in a pure lib
// (code OR comment) trips this — comments re-bake the convention into the
// reader's mental model just as code does.
const BAKED = /\.forgeax\/games/;

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // package not checked out — skip
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

describe('layout decoupling — pure libs hold zero host disk convention', () => {
  for (const root of PURE_LIB_ROOTS) {
    test(`${root} contains no baked .forgeax/games literal`, () => {
      const offenders: string[] = [];
      for (const file of walk(join(PKGS_ROOT, root))) {
        const src = readFileSync(file, 'utf8');
        src.split('\n').forEach((line, i) => {
          if (BAKED.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        });
      }
      expect(offenders).toEqual([]);
    });
  }
});
