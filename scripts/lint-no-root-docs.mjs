#!/usr/bin/env node

import { lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function checkRootDocs(root) {
  const docsPath = join(root, 'docs');
  try {
    lstatSync(docsPath);
    return {
      ok: false,
      message: `root docs directory is forbidden: ${docsPath}; write repository documentation under .forgeax-harness/docs/`,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, message: 'root docs directory is absent' };
    return { ok: false, message: `cannot inspect ${docsPath}: ${error.message}` };
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const result = checkRootDocs(repoRoot);
  if (!result.ok) {
    console.error(`[lint-no-root-docs] FAIL: ${result.message}`);
    process.exit(1);
  }
  console.log(`[lint-no-root-docs] OK: ${result.message}`);
}
