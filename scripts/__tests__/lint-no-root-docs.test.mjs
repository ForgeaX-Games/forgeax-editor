#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { checkRootDocs } from '../lint-no-root-docs.mjs';

test('accepts a repository without a root docs directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-no-root-docs-'));
  try {
    assert.deepEqual(checkRootDocs(root), { ok: true, message: 'root docs directory is absent' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a root docs directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-root-docs-'));
  try {
    mkdirSync(join(root, 'docs'));
    const result = checkRootDocs(root);
    assert.equal(result.ok, false);
    assert.match(result.message, /root docs directory is forbidden/);
    assert.match(result.message, /\.forgeax-harness\/docs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
