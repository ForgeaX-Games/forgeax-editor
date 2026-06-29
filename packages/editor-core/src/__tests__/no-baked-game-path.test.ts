// no-baked-game-path.test.ts — regression guard for the layout decoupling
// (feedback 2026-06-25-editor-bakes-game-path-convention).
//
// HARD REQUIREMENT: the pure libraries editor-core / editor-shared must hold
// ZERO host disk-layout convention. The studio games-directory path is the
// HOST's concern, injected via setPathResolver — never baked into a string
// literal in the library. dependency-cruiser guards the package DAG but cannot
// see string literals; this red-line fills that gap (the feedback's Layer 3 ②).
//
// If this fails: you (re)introduced a `.forgeax/games` literal in a pure lib.
// Use resolveGamePath('<game-relative-path>') instead and let the host
// (edit-runtime adapter / EditSurface) own the convention.

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// editor-core/src/__tests__ → ../../.. = packages/editor/packages
const PKGS_ROOT = join(import.meta.dir, '..', '..', '..');

// PURE LIBS ONLY. edit-runtime / editor-panels are host/runtime adapters that
// legitimately own the convention, so they are deliberately NOT scanned here.
const PURE_LIB_ROOTS = ['editor-core/src', 'editor-shared/src'];

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
