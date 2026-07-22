#!/usr/bin/env node
// Full-tree M5 gate: UI packages may read /api/files, but file writes must pass
// through core AssetIOFacade + gateway appliers. writeback-chain.ts is the one
// pre-existing runtime transport exception and is registered explicitly here.

import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const allowed = new Set(['packages/edit-runtime/src/writeback-chain.ts']);

// This runs in the minimal CI image too, which intentionally does not promise
// ripgrep. Keep the gate hermetic: Node's filesystem API is sufficient for the
// small, fixed source scope. Do not follow generated Vite farm symlinks into
// host-owned content.
function sourceFiles() {
  const files = [];
  function walk(relDir) {
    const absDir = resolve(root, relDir);
    let entries;
    try { entries = readdirSync(absDir); } catch { return; }
    for (const name of entries) {
      if (name === 'node_modules' || name === '.git') continue;
      const rel = join(relDir, name);
      let stat;
      try { stat = lstatSync(resolve(root, rel)); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(rel);
      else files.push(rel);
    }
  }
  walk('packages');
  walk('standalone');
  return files;
}

const files = sourceFiles();
const uiPrefix = /^(?:packages\/(?:content-browser|panels|edit-runtime|ui)\/src\/|standalone\/)/;
const fileApiFetch = /fetch\s*(?:<[^>]*>)?\s*\(\s*['"`][^'"`]*\/api\/files(?:[/?][^'"`]*)?['"`][\s\S]{0,1200}?\)/g;
const mutation = /\bmethod\s*:\s*['"](?:DELETE|POST|PUT|PATCH)['"]/i;
const offenders = [];

for (const file of files) {
  if (!uiPrefix.test(file) || allowed.has(file) || !/\.(?:ts|tsx|js|jsx)$/.test(file)) continue;
  const source = readFileSync(resolve(root, file), 'utf8');
  for (const match of source.matchAll(fileApiFetch)) {
    if (!mutation.test(match[0])) continue;
    const index = match.index ?? 0;
    const line = source.slice(0, index).split('\n').length;
    const excerpt = match[0].replace(/\s+/g, ' ').trim();
    offenders.push(`${file}:${line}: ${excerpt}`);
  }
}

if (offenders.length) {
  console.error('[lint-no-ui-file-mutation] UI file mutation violation:');
  for (const offender of offenders) console.error(`  ${offender}`);
  console.error('[lint-no-ui-file-mutation] Route the operation through gateway.dispatch and implement the write in a core applier using AssetIOFacade. Read-only raw/tree fetches remain allowed.');
  process.exit(1);
}
console.log('[lint-no-ui-file-mutation] OK -- no UI /api/files writes');
