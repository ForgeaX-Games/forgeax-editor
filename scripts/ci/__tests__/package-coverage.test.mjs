import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  comparePackageCoverage,
  comparePackageCoverageBatch,
  packageTestEnvironment,
  packageCoverageProducerArgs,
  parsePackageCoverageText,
} from '../package-coverage.mjs';

const fixturePath = resolve('scripts/ci/fixtures/package-coverage-cases.json');

function lcovRecord(source, { linesFound, linesHit, functionsFound, functionsHit }) {
  return [
    `SF:${source}`,
    `LF:${linesFound}`,
    `LH:${linesHit}`,
    `FNF:${functionsFound}`,
    `FNH:${functionsHit}`,
    'end_of_record',
  ].join('\n');
}

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

test('package coverage producer forces test mode without dropping caller environment', () => {
  const callerEnvironment = { NODE_ENV: 'production', PATH: '/usr/bin', CI: '1' };
  assert.deepEqual(packageTestEnvironment(callerEnvironment), {
    NODE_ENV: 'test',
    PATH: '/usr/bin',
    CI: '1',
  });
  assert.deepEqual(callerEnvironment, { NODE_ENV: 'production', PATH: '/usr/bin', CI: '1' });
});

test('package coverage attributes each producer to its owning package boundary', () => {
  const lcov = [
    lcovRecord('src/core-owned.ts', { linesFound: 4, linesHit: 2, functionsFound: 2, functionsHit: 1 }),
    lcovRecord('../product/src/reference-creation.ts', { linesFound: 100, linesHit: 100, functionsFound: 50, functionsHit: 50 }),
    lcovRecord('../engine/dist/dependency.mjs', { linesFound: 100, linesHit: 100, functionsFound: 50, functionsHit: 50 }),
  ].join('\n');

  const coreCoverage = parsePackageCoverageText(
    lcov,
    '/repo/packages/core',
    ['/repo/packages/engine'],
  );
  assert.deepEqual(coreCoverage, {
    ok: true,
    lines: 50,
    functions: 50,
  });

  const legacyPreservedSiblingCoverage = { ok: true, lines: 98.08, functions: 98.08 };
  assert.notDeepEqual(coreCoverage, legacyPreservedSiblingCoverage);

  const productLcov = [
    lcovRecord('src/product-owned.ts', { linesFound: 4, linesHit: 2, functionsFound: 2, functionsHit: 1 }),
    lcovRecord('../core/src/manifest.ts', { linesFound: 100, linesHit: 100, functionsFound: 50, functionsHit: 50 }),
    lcovRecord('../engine/dist/dependency.mjs', { linesFound: 100, linesHit: 100, functionsFound: 50, functionsHit: 50 }),
  ].join('\n');

  assert.deepEqual(parsePackageCoverageText(
    productLcov,
    '/repo/packages/product',
    ['/repo/packages/engine'],
  ), {
    ok: true,
    lines: 50,
    functions: 50,
  });
});

test('package coverage fails closed when owner-local LCOV records are empty', () => {
  const siblingOnlyLcov = [
    lcovRecord('../product/src/reference-creation.ts', { linesFound: 100, linesHit: 100, functionsFound: 50, functionsHit: 50 }),
    lcovRecord('../engine/dist/dependency.mjs', { linesFound: 100, linesHit: 100, functionsFound: 50, functionsHit: 50 }),
  ].join('\n');

  assert.deepEqual(parsePackageCoverageText(
    siblingOnlyLcov,
    '/repo/packages/core',
    ['/repo/packages/engine'],
  ), {
    ok: false,
    error: {
      code: 'coverage-dimension-missing',
      expected: 'non-empty LCOV lines and functions dimensions',
      observed: { linesFound: 0, linesHit: 0, functionsFound: 0, functionsHit: 0 },
      hint: 'Do not replace a missing package dimension with an aggregate result.',
    },
  });
});
