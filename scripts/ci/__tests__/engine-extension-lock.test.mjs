import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = resolve(import.meta.dirname, '../../..');
const lockfile = readFileSync(resolve(repoRoot, 'bun.lock'), 'utf8');
const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'packages/engine-extension/package.json'), 'utf8'));

test('merge-ref workspace graph includes the Engine extension package', () => {
  const projection = /"packages\/engine-extension": \{\s+"name": "([^"]+)",\s+"version": "([^"]+)"/u.exec(lockfile);

  assert.ok(projection, 'bun.lock must materialize the Engine extension workspace');
  assert.equal(projection[1], manifest.name);
  assert.equal(projection[2], manifest.version);
});
