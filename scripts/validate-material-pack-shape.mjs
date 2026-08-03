#!/usr/bin/env node

// Asset contract gate for editor-owned material packs. Material pass metadata
// belongs to `renderState`; the engine intentionally consumes only that shape.

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const gamesRoot = join(root, 'games');
const violations = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
    } else if (entry.isFile() && entry.name.endsWith('.pack.json')) {
      await inspectPack(path);
    }
  }
}

async function inspectPack(path) {
  const pack = JSON.parse(await readFile(path, 'utf8'));
  for (const [assetIndex, asset] of (pack.assets ?? []).entries()) {
    if (asset?.kind !== 'material') continue;
    for (const [passIndex, pass] of (asset.payload?.passes ?? []).entries()) {
      for (const field of ['tags', 'queue', 'passKind']) {
        if (Object.hasOwn(pass, field)) {
          violations.push(
            `${relative(root, path)} asset[${assetIndex}] pass[${passIndex}]: ` +
              `move '${field}' into renderState`,
          );
        }
      }
    }
  }
}

await walk(gamesRoot);

if (violations.length > 0) {
  console.error('[material-pack-shape] invalid material pass metadata:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log('[material-pack-shape] all editor-owned material passes use renderState');
}
