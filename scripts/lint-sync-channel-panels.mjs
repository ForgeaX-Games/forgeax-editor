#!/usr/bin/env node
// lint-sync-channel-panels.mjs
//
// Order-sensitive guard for the EDITOR_PANELS literal duplicated between
//   * packages/editor-shared/src/manifest.ts (SSOT)
//   * packages/editor-core/src/sync-channel.ts (inline copy)
//
// The inline copy exists by design (plan-strategy §2 D-2): editor-shared
// would create a shared->core dep cycle if imported from sync-channel.ts.
// This lint backstops the duplication so any drift trips CI rather than
// rotting silently. Removing the duplication itself is deferred to a
// later P1.5b structural fix.
//
// Usage:
//   node lint-sync-channel-panels.mjs
//   node lint-sync-channel-panels.mjs --shared-path <ts> --core-path <ts>
//
// Exits 0 on agreement, 1 on drift (with a readable diff on stderr), 2 on
// internal error (file missing, regex miss).
//
// Anchors:
//   AC-02 (lint script ordering-sensitive comparison)
//   plan-strategy §2 D-2 (inline locked, lint backstop)
//   plan-strategy §2 D-10 (script lives at packages/editor/scripts/)

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ROOT = resolve(__dirname, '..');

const DEFAULT_SHARED = resolve(
  EDITOR_ROOT,
  'packages/editor-shared/src/manifest.ts',
);
const DEFAULT_CORE = resolve(
  EDITOR_ROOT,
  'packages/editor-core/src/sync-channel.ts',
);

function parseArgs(argv) {
  const out = { sharedPath: DEFAULT_SHARED, corePath: DEFAULT_CORE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--shared-path') out.sharedPath = resolve(argv[++i]);
    else if (a === '--core-path') out.corePath = resolve(argv[++i]);
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: lint-sync-channel-panels.mjs [--shared-path <ts>] [--core-path <ts>]\n',
      );
      process.exit(0);
    } else {
      process.stderr.write(`lint-sync-channel-panels: unknown arg ${a}\n`);
      process.exit(2);
    }
  }
  return out;
}

function extractPanels(filePath, label) {
  let src;
  try {
    src = readFileSync(filePath, 'utf8');
  } catch (err) {
    process.stderr.write(
      `lint-sync-channel-panels: cannot read ${label} (${filePath}): ${err.message}\n`,
    );
    process.exit(2);
  }
  const m = src.match(/EDITOR_PANELS\s*=\s*\[([\s\S]*?)\]\s*as\s+const/);
  if (!m) {
    process.stderr.write(
      `lint-sync-channel-panels: EDITOR_PANELS literal not found in ${label} (${filePath})\n`,
    );
    process.exit(2);
  }
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function buildDiff(ssot, inline) {
  const lines = [];
  const max = Math.max(ssot.length, inline.length);
  for (let i = 0; i < max; i++) {
    const a = ssot[i];
    const b = inline[i];
    if (a === b) {
      lines.push(`  [${i}] ${a}`);
    } else if (a !== undefined && b !== undefined) {
      lines.push(`! [${i}] ssot=${a}  inline=${b}`);
    } else if (a === undefined) {
      lines.push(`+ [${i}] inline-only=${b}`);
    } else {
      lines.push(`- [${i}] ssot-only=${a}`);
    }
  }
  return lines.join('\n');
}

function main() {
  const { sharedPath, corePath } = parseArgs(process.argv.slice(2));
  const ssot = extractPanels(sharedPath, 'shared SSOT');
  const inline = extractPanels(corePath, 'core inline');

  const equal =
    ssot.length === inline.length && ssot.every((p, i) => p === inline[i]);

  if (equal) {
    process.exit(0);
  }

  process.stderr.write(
    'lint-sync-channel-panels: EDITOR_PANELS drift detected.\n',
  );
  process.stderr.write(`  ssot:   ${sharedPath}\n`);
  process.stderr.write(`  inline: ${corePath}\n`);
  process.stderr.write(`  ssot   = [${ssot.map((p) => `'${p}'`).join(', ')}]\n`);
  process.stderr.write(
    `  inline = [${inline.map((p) => `'${p}'`).join(', ')}]\n`,
  );
  process.stderr.write('  diff:\n');
  process.stderr.write(`${buildDiff(ssot, inline)}\n`);
  process.stderr.write(
    '  fix: keep inline EDITOR_PANELS in editor-core/src/sync-channel.ts byte-identical with editor-shared/src/manifest.ts (plan-strategy D-2 lock).\n',
  );
  process.exit(1);
}

main();
