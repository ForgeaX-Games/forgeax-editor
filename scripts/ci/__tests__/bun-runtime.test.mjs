import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveBunExecutable } from '../bun-runtime.mjs';

test('CI_BUN_PATH is authoritative for nested Bun commands', () => {
  const env = { CI_BUN_PATH: '/run-scoped/bun/bin/bun' };
  assert.equal(resolveBunExecutable('bun', env), env.CI_BUN_PATH);
  assert.equal(resolveBunExecutable('node', env), 'node');
});
