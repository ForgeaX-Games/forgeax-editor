#!/usr/bin/env node
// lint-no-bare-engine-shim.mjs — engine-surface type-safety gate.
//
// The editor authors *against* the engine; it must never import a symbol the
// engine does not export (the `Socket` regression: main.tsx imported
// `{ Socket }` from @forgeax/engine-runtime, a symbol that never existed, and it
// crashed at the user's runtime — AGENTS.md anti-pattern #5). tsc CAN catch that
// (TS2305 has-no-exported-member) — UNLESS a bodyless `declare module '…';`
// downgrades the whole engine module to `any`, which suppresses ALL named-import
// checking for that module. That is exactly what the `forgeax-engine.d.ts` shims
// used to do, and it is what let `Socket` through.
//
// This gate forbids bodyless engine shims. A shim is allowed only as an EXPLICIT
// SURFACE — `declare module '@forgeax/engine-foo' { export const x: any; … }` —
// which acts as a hand-maintained allowlist: importing an undeclared name from
// it still fails typecheck. For any engine package that already ships real
// `.d.ts` (runtime / ecs / types / gltf / pack / math …) the shim entry should
// simply be deleted so the real types take over.
//
// SCANS  types/forgeax-engine-shims.d.ts (the shared SSOT surface) AND any
//        stray packages/{editor-core,editor-panels,editor-edit-runtime,
//        editor-play-runtime}/src/forgeax-engine.d.ts (defense-in-depth: catches a
//        re-added per-package bare shim even though the shared file is canonical).
// SKIPS  packages/interface (git submodule — studio's shared shell, its own
//        repo's concern), and any other submodule this repo doesn't own.
// FLAGS  a `declare module '@forgeax/engine-…'` NOT immediately followed by `{`
//        (i.e. bodyless — terminated by `;`), which erases the module to `any`.
//
// Usage:   node scripts/lint-no-bare-engine-shim.mjs
// Exits    0 clean · 1 violations (listed on stderr) · 2 internal error.

import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ROOT = resolve(__dirname, '..');
const PACKAGES_DIR = resolve(EDITOR_ROOT, 'packages');

// Editor-proper packages only — mirrors lint-no-direct-api-fetch.mjs's scope.
// packages/interface & platform-io are git submodules (other repos' concern).
const SCAN_PACKAGES = [
  'editor-core',
  'editor-content-browser',
  'editor-panels',
  'editor-edit-runtime',
  'editor-play-runtime',
];

// A `declare module '@forgeax/engine-...'` whose declaration is bodyless:
// after the closing quote comes optional whitespace then `;` (no `{`).
// Matches both single and double quotes; the module name must be an engine one.
const BARE_ENGINE_SHIM =
  /\bdeclare\s+module\s+(['"])@forgeax\/engine-[^'"]*\1\s*;/;

// The shared SSOT surface + any stray per-package shim files, if present.
function findShimFiles() {
  const out = [];
  const shared = resolve(EDITOR_ROOT, 'types', 'forgeax-engine-shims.d.ts');
  try {
    if (statSync(shared).isFile()) out.push(shared);
  } catch {
    // shared shim absent — fine (engine may ship all .d.ts)
  }
  // The repo-root program's shim slot. It was DELETED (the root tsconfig now
  // includes the shared SSOT shim and resolves engine-ecs/types/… to real
  // dist), but scan it anyway as defense-in-depth: a re-added bare shim here
  // would re-erase the engine surface to `any` for the root typecheck program.
  const rootShim = resolve(EDITOR_ROOT, 'src', 'forgeax-engine.d.ts');
  try {
    if (statSync(rootShim).isFile()) out.push(rootShim);
  } catch {
    // no root shim — the intended steady state.
  }
  for (const pkg of SCAN_PACKAGES) {
    const candidate = join(PACKAGES_DIR, pkg, 'src', 'forgeax-engine.d.ts');
    try {
      if (statSync(candidate).isFile()) out.push(candidate);
    } catch {
      // no stray per-package shim — good
    }
  }
  return out;
}

function main() {
  const files = findShimFiles();
  const violations = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip comment lines so a bare shim quoted in a comment doesn't trip.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      if (BARE_ENGINE_SHIM.test(line)) {
        violations.push({ file: relative(EDITOR_ROOT, file), line: i + 1, text: line.trim() });
      }
    }
  }

  if (violations.length > 0) {
    console.error(
      `\n✗ engine-surface gate: ${violations.length} bodyless \`declare module '@forgeax/engine-*'\` shim(s).\n` +
      `  A bodyless shim erases the engine module to \`any\`, so tsc stops checking\n` +
      `  named imports from it — this is exactly how the non-existent \`Socket\` import\n` +
      `  slipped through (AGENTS.md anti-pattern #5).\n` +
      `  Fix: delete the entry if the package ships real .d.ts, or give it an explicit\n` +
      `  surface — declare module '…' { export const x: any; export type T = any; }.\n`,
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.text}`);
    }
    console.error('');
    process.exit(1);
  }

  console.log(`✓ engine-surface gate: no bodyless engine shims (${files.length} shim file(s) scanned).`);
}

try {
  main();
} catch (err) {
  console.error('lint-no-bare-engine-shim: internal error:', err);
  process.exit(2);
}
