import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  comparePackageCoverage,
  comparePackageCoverageBatch,
  packageCoverageProducerArgs,
  parsePackageCoverageText,
} from './package-coverage.mjs';

const fixturePath = resolve('scripts/ci/fixtures/package-coverage-cases.json');

test('package coverage compares lines and functions independently', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  for (const mutation of fixture.cases) {
    const result = comparePackageCoverage(mutation.input);
    if (mutation.expectedError) {
      assert.equal(result.ok, false, mutation.name);
      assert.equal(result.error.code, mutation.expectedError, mutation.name);
      assert.deepEqual(Object.keys(result.error).sort(), ['code', 'expected', 'hint', 'observed'].sort(), mutation.name);
    } else {
      assert.equal(result.ok, true, mutation.name);
      assert.deepEqual(result.observed, mutation.input.observed, mutation.name);
    }
  }
});

test('package coverage reports every observed package when multiple floors regress', () => {
  const result = comparePackageCoverageBatch([
    {
      packageName: '@forgeax/a',
      floors: { lines: 80, functions: 70 },
      observed: { packageName: '@forgeax/a', lines: 79, functions: 70, lcovPath: 'a/lcov.info' },
    },
    {
      packageName: '@forgeax/b',
      floors: { lines: 60, functions: 50 },
      observed: { packageName: '@forgeax/b', lines: 60, functions: 49, lcovPath: 'b/lcov.info' },
    },
    {
      packageName: '@forgeax/c',
      floors: { lines: 40, functions: 30 },
      observed: { packageName: '@forgeax/c', lines: 41, functions: 31, lcovPath: 'c/lcov.info' },
    },
  ]);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((entry) => entry.packageName), ['@forgeax/a', '@forgeax/b']);
  assert.deepEqual(result.observations.map((entry) => entry.packageName), ['@forgeax/a', '@forgeax/b', '@forgeax/c']);
});

test('package coverage producer serializes tests before collecting LCOV', () => {
  const result = packageCoverageProducerArgs('bun test src', '/tmp/package-evidence');
  assert.equal(result.ok, true);
  assert.deepEqual(result.args, [
    'src',
    '--timeout=15000',
    '--max-concurrency=1',
    '--coverage',
    '--coverage-reporter=lcov',
    '--coverage-dir',
    '/tmp/package-evidence',
    '--pass-with-no-tests',
  ]);
});

test('package coverage producer preserves an explicit package timeout', () => {
  const result = packageCoverageProducerArgs('bun test --timeout=9000 src', '/tmp/package-evidence');
  assert.equal(result.ok, true);
  assert.equal(result.args.filter((arg) => arg.startsWith('--timeout')).length, 1);
  assert.equal(result.args[0], '--timeout=9000');
});

test('package coverage excludes gitlink records while preserving Editor-owned sibling coverage', () => {
  const lcov = [
    'SF:src/owned.ts',
    'LF:4',
    'LH:2',
    'FNF:2',
    'FNH:1',
    'end_of_record',
    'SF:../core/src/editor-owned.ts',
    'LF:4',
    'LH:4',
    'FNF:2',
    'FNH:2',
    'end_of_record',
    'SF:../engine/dist/dependency.mjs',
    'LF:100',
    'LH:0',
    'FNF:50',
    'FNH:0',
    'end_of_record',
  ].join('\n');

  assert.deepEqual(parsePackageCoverageText(
    lcov,
    '/repo/packages/content-browser',
    ['/repo/packages/engine'],
  ), {
    ok: true,
    lines: 75,
    functions: 75,
  });
});
