// sync-radix-hoist — promote @radix-ui transitive deps from bun's .bun store to
// the top-level node_modules/@radix-ui/ so Vite (and Node) can resolve them.
//
// Root cause: Bun 1.3.14's isolated install does NOT hoist @radix-ui transitive
// dependencies (react-compose-refs, primitive, react-context, ...) to the
// top-level node_modules/@radix-ui/. They live in node_modules/.bun/@radix-ui+*/
// node_modules/@radix-ui/<pkg>/ but no symlink exposes them where Vite's
// upward node_modules resolution can find them, so editor edit-runtime hits
// "Pre-transform error: Failed to resolve import @radix-ui/..." and renders
// blank. This script mirrors bun's own hoist by symlinking every @radix-ui
// package found in the .bun store into the top-level @radix-ui scope.
//
// Run after `bun install`. Idempotent: existing valid symlinks are kept; stale
// ones (pointing at a removed store entry) are replaced. Safe to re-run.
//
// This is a workaround for Bun's hoisting behavior, not a project dependency
// change — it only creates symlinks inside node_modules (gitignored).

import { mkdir, readdir, readlink, symlink, lstat, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve('node_modules');
const storeDir = resolve('node_modules/.bun');
const scopeDir = resolve('node_modules/@radix-ui');

let created = 0;
let kept = 0;
let replaced = 0;

try {
  await mkdir(scopeDir, { recursive: true });
} catch {
  // already exists
}

let storeEntries = [];
try {
  storeEntries = await readdir(storeDir);
} catch {
  // no .bun store — nothing to hoist
  process.exit(0);
}

for (const entry of storeEntries) {
  if (!entry.startsWith('@radix-ui+')) continue;
  // entry layout: @radix-ui+<pkg>@<ver>[+<hash>]
  const innerPkgDir = resolve(storeDir, entry, 'node_modules/@radix-ui');
  let pkgs = [];
  try {
    pkgs = await readdir(innerPkgDir);
  } catch {
    continue;
  }
  for (const pkg of pkgs) {
    const target = resolve(innerPkgDir, pkg);
    const link = resolve(scopeDir, pkg);
    let st;
    try {
      st = await lstat(link);
    } catch {
      st = null;
    }
    if (st && st.isSymbolicLink()) {
      const cur = await readlink(link).catch(() => null);
      if (cur === target) {
        kept++;
        continue;
      }
      // stale symlink — replace
      await rm(link, { force: true });
      replaced++;
    } else if (st) {
      // a real file/dir occupies the name — leave it, don't clobber.
      kept++;
      continue;
    }
    try {
      await symlink(target, link, 'dir');
      created++;
    } catch (e) {
      process.stderr.write(`sync-radix-hoist: skip ${pkg}: ${e.message}\n`);
    }
  }
}

process.stdout.write(
  `sync-radix-hoist: ${created} created, ${kept} kept, ${replaced} replaced\n`,
);
