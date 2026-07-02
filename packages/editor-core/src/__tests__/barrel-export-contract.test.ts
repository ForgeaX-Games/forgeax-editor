// barrel-export-contract.test.ts — consumer-driven completeness guard for the
// @forgeax/editor-core barrel (src/index.ts).
//
// WHY THIS EXISTS (bug-20260624): store.ts exported `hasPendingDiskSave`, but
// the barrel's store re-export block omitted it. The consumer
// edit-runtime/src/components/dirty-indicator.tsx did
// `import { hasPendingDiskSave } from '@forgeax/editor-core'`, which threw at
// RUNTIME (vite ESM, editor :15280): "does not provide an export named
// 'hasPendingDiskSave'". CI never caught it — two blind spots:
//   1. typecheck fan-out (ci.yml) skips the editor SUBpackages
//      (editor-core/edit-runtime/play-runtime/editor-shared/editor-panels), so
//      the consumer's TS2305 was never compiled.
//   2. ci.yml runs no unit tests; nightly only tests types/host-sdk/server.
// Adding those subpackages to a tsc gate isn't viable (pre-existing engine-
// boundary type debt makes them deeply red). This focused, hermetic test fills
// the gap: every name editor-family code imports from the BARE
// '@forgeax/editor-core' specifier must be reachable through the barrel.
//
// HYBRID check (both verified to run cleanly under bun test):
//   - VALUE imports → runtime namespace: `name in barrel`. Faithfully
//     reproduces the runtime-error class (a missing value export => false).
//   - TYPE imports (`import type {…}` or inline `type X`) → barrel SOURCE
//     text: `export type {…}` names are erased from the runtime namespace, so
//     they must be parsed out of index.ts.
// Hermetic: only the barrel itself is imported (it already transitively loads
// engine-runtime — the existing editor-core suites prove that's side-effect
// free in bun test). No consumer module is loaded (avoids panel DOM globals).
//
// Style anchor: packages/editor/src/index.test.ts + the feat's w1 export grep
// contract. Lowest maintenance: consumer set is glob-discovered, surfaces are
// parsed — adding a consumer file or a barrel export needs no edit here.

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import * as barrel from '../index';

// editor-core/src/__tests__ → ../../.. = packages/editor/packages
const PKGS_ROOT = join(import.meta.dir, '..', '..', '..');
const BARREL_SRC = readFileSync(join(PKGS_ROOT, 'editor-core', 'src', 'index.ts'), 'utf8');

const CONSUMER_ROOTS = [
  'edit-runtime/src',
  'editor-panels/src',
  'editor-shared/src',
  'play-runtime/src',
  'editor-core/src',
];

const EXCLUDE = /(__tests__|\.test\.|node_modules|broken-syntax|[/\\]fixtures[/\\])/;

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // root may not exist (e.g. package not checked out) — skip
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

// Parse the set of `export type { … }` identifiers out of the barrel source.
// These are erased from the runtime namespace, so type-only consumer imports
// are validated against this set rather than `in barrel`.
function parseTypeExportSurface(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/export\s+type\s*\{([^}]*)\}/g)) {
    for (const raw of m[1]!.split(',')) {
      const id = raw.trim().split(/\s+as\s+/).pop()!.trim();
      if (id) names.add(id);
    }
  }
  return names;
}

// Extract names imported from the BARE '@forgeax/editor-core' specifier.
// Subpath imports (/protocol, /manifest) resolve to their own modules, never
// through the barrel, so they are intentionally NOT matched. Returns value vs
// type names separately (an inline `type X` inside a value block is a type).
function parseBarrelImports(src: string): { values: string[]; types: string[] } {
  const values: string[] = [];
  const types: string[] = [];
  // Bare specifier only — the negative lookahead rejects /protocol, /manifest.
  const re =
    /import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]@forgeax\/editor-core['"]/g;
  for (const m of src.matchAll(re)) {
    const blockIsType = Boolean(m[1]);
    for (const raw of m[2]!.split(',')) {
      let spec = raw.trim();
      if (!spec) continue;
      let isType = blockIsType;
      if (spec.startsWith('type ')) {
        isType = true;
        spec = spec.slice('type '.length).trim();
      }
      const name = spec.split(/\s+as\s+/)[0]!.trim();
      if (!name || name.startsWith('//')) continue;
      (isType ? types : values).push(name);
    }
  }
  return { values, types };
}

const TYPE_SURFACE = parseTypeExportSurface(BARREL_SRC);
const CONSUMER_FILES = CONSUMER_ROOTS.flatMap((r) => walk(join(PKGS_ROOT, r)));

describe('@forgeax/editor-core barrel export completeness', () => {
  test('sanity: barrel surface + consumer set discovered (guard against glob breakage)', () => {
    // value exports on the runtime namespace + type-only exports from source.
    const valueCount = Object.keys(barrel).length;
    expect(valueCount).toBeGreaterThan(30);
    expect(TYPE_SURFACE.size).toBeGreaterThan(10);
    expect(CONSUMER_FILES.length).toBeGreaterThan(20);
  });

  for (const file of CONSUMER_FILES) {
    const { values, types } = parseBarrelImports(readFileSync(file, 'utf8'));
    if (values.length === 0 && types.length === 0) continue;
    const rel = file.slice(PKGS_ROOT.length + 1);
    test(`${rel} imports only names the barrel exports`, () => {
      const missingValues = values.filter((n) => !(n in barrel));
      const missingTypes = types.filter((n) => !TYPE_SURFACE.has(n));
      const missing = [...missingValues, ...missingTypes];
      expect(
        missing,
        `add to editor-core/src/index.ts: ${missing.join(', ')}`,
      ).toEqual([]);
    });
  }
});
