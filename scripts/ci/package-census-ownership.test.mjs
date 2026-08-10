import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { classifyOwnership } from './package-census-ownership.mjs';

const fixturePath = resolve('scripts/ci/fixtures/package-census-ownership.json');

test('ownership classifier is mutually exclusive and preserves submodule boundaries', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  for (const mutation of fixture.cases) {
    const result = classifyOwnership(mutation.input);
    if (mutation.expectedError) {
      assert.equal(result.ok, false, mutation.name);
      assert.equal(result.errors[0].code, mutation.expectedError, mutation.name);
      assert.equal(typeof result.errors[0].hint, 'string', mutation.name);
      continue;
    }
    assert.equal(result.ok, true, mutation.name);
    assert.deepEqual(result.surfaces.map((surface) => surface.ownership), mutation.expectedClasses, mutation.name);
    assert.equal(new Set(result.surfaces.map((surface) => surface.path)).size, result.surfaces.length, mutation.name);
  }
});

test('every failed ownership mutation reports an executable recovery hint', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  for (const mutation of fixture.cases.filter((entry) => entry.expectedError)) {
    const result = classifyOwnership(mutation.input);
    assert.equal(result.ok, false, mutation.name);
    assert.equal(result.errors[0].observed !== undefined, true, mutation.name);
    assert.match(result.errors[0].hint, /(?:declare|remove|add|restore|move|keep)/i, mutation.name);
  }
});
