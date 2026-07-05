#!/usr/bin/env node
// lint-no-direct-api-fetch.mjs — R2 DIP-seam gate.
//
// The editor (前L2) must reach its backend ONLY through the injected ApiClient
// (editor-core/src/api-client.ts). A raw `fetch('/api/...')` re-hardcodes the
// transport and silently re-couples the editor to studio's relative-`/api`
// origin — exactly the "baked the convention back in" regression the seam
// removes (roadmap §4/§5, ideal-clean-architecture.md). This gate trips CI on
// any such call in editor-proper source so the seam can't rot.
//
// SCANS  packages/{core,panels,edit-runtime,play-runtime}/src
//        (the reusable editor packages)
// SKIPS  packages/interface (studio's shared shell — R4's job, not R2's),
//        api-client.ts (the seam itself), *.test.* / __tests__ (mock fetch),
//        node_modules / dist / .vite.
//
// FLAGS  fetch('/api …), fetch(`/api …), fetch(`${anyVar}/api …)
//        i.e. a fetch whose URL literal begins with (an optional base then) /api.
//        Calls via getApiClient().fetch(...) / createDefaultApiClient(b).fetch(...)
//        are NOT `fetch(` token-adjacent to a `/api` literal, so they pass.
//
// Usage:   node scripts/lint-no-direct-api-fetch.mjs
// Exits    0 clean · 1 violations (listed on stderr) · 2 internal error.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ROOT = resolve(__dirname, '..');

const SCAN_PACKAGES = [
  'core',
  'content-browser',
  'panels',
  'edit-runtime',
  'play-runtime',
];

// A `fetch(` whose URL literal starts with `/api` or `${base}/api` etc.
// Matches the call token `fetch(` (not `.fetch(`) followed by a quote/backtick,
// an optional `${ident}` base, then `/api`.
const DIRECT_API_FETCH =
  /(?<![.\w])fetch\(\s*(['"`])(?:\$\{[a-zA-Z_$][\w$]*\})?\/api\b/;

function listSourceFiles(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc; // package or src/ absent — nothing to scan
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.vite') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === '__tests__') continue;
      listSourceFiles(full, acc);
    } else if (/\.(ts|tsx)$/.test(name)) {
      if (/\.test\.(ts|tsx)$/.test(name)) continue;
      if (name === 'api-client.ts') continue; // the seam itself
      acc.push(full);
    }
  }
  return acc;
}

function main() {
  const files = [];
  for (const pkg of SCAN_PACKAGES) {
    listSourceFiles(resolve(EDITOR_ROOT, 'packages', pkg, 'src'), files);
  }

  const violations = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (DIRECT_API_FETCH.test(lines[i])) {
        violations.push({
          file: relative(EDITOR_ROOT, file),
          line: i + 1,
          text: lines[i].trim(),
        });
      }
    }
  }

  if (violations.length > 0) {
    console.error(
      `\n✗ R2 DIP-seam gate: ${violations.length} direct /api fetch(s) in editor-proper source.\n` +
      `  Route backend calls through getApiClient().fetch(...) ` +
      `(or createDefaultApiClient(base).fetch(...) when a base is threaded).\n`,
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.text}`);
    }
    console.error('');
    process.exit(1);
  }

  console.log(`✓ R2 DIP-seam gate: no direct /api fetch in editor-proper source (${files.length} files scanned).`);
}

try {
  main();
} catch (err) {
  console.error('lint-no-direct-api-fetch: internal error:', err);
  process.exit(2);
}
