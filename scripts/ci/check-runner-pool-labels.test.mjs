import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  checkWorkflowDirectory,
  checkWorkflowText,
  classifyRunnerSelector,
} from './check-runner-pool-labels.mjs';

const runnerFixture = resolve('scripts/ci/fixtures/runner-label-contract.yml');

test('the editor workflow declares an explicit pool for every self-hosted job', () => {
  const result = checkWorkflowDirectory(resolve('.github/workflows'));
  assert.deepEqual(result.errors, []);

  const pools = result.selectors
    .filter((selector) => selector.kind === 'self-hosted')
    .map((selector) => selector.pool);
  assert.ok(pools.includes('standard'));
  assert.ok(pools.includes('heavy'));
});

test('editor CI routes ordinary jobs to standard and browser smoke to heavy', () => {
  const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
  const pools = Object.fromEntries(
    checkWorkflowText(workflow, 'ci.yml').selectors.map((selector) => [selector.job, selector.pool]),
  );
  assert.deepEqual(pools, {
    'doc-gate': 'standard',
    'submodule-pin': 'standard',
    'b2-self-boot': 'standard',
    typecheck: 'standard',
    'smoke-play': 'heavy',
  });
});

test('a self-hosted selector without a pool is rejected', () => {
  const result = checkWorkflowText(
    `name: invalid\njobs:\n  build:\n    runs-on: [self-hosted, Linux, X64]\n`,
    'invalid.yml',
  );
  assert.match(result.errors.join('\n'), /build/);
  assert.match(result.errors.join('\n'), /standard or heavy/);
});

test('a selector cannot combine standard and heavy', () => {
  const result = classifyRunnerSelector('[self-hosted, Linux, X64, standard, heavy]');
  assert.equal(result.kind, 'error');
  assert.match(result.message, /exactly one/);
});

test('GitHub-hosted selectors remain valid', () => {
  assert.deepEqual(classifyRunnerSelector('ubuntu-latest'), {
    kind: 'github-hosted',
    labels: ['ubuntu-latest'],
  });
});

test('contract fixture keeps one capacity label for every self-hosted selector', () => {
  const result = checkWorkflowText(readFileSync(runnerFixture, 'utf8'), 'runner-label-contract.yml');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.selectors.filter((selector) => selector.kind === 'self-hosted').map((selector) => selector.pool),
    ['standard', 'heavy'],
  );
});

test('dynamic selectors without static matrix values are rejected', () => {
  const result = classifyRunnerSelector('fromJSON(matrix.runner)');
  assert.equal(result.kind, 'error');
  assert.match(result.message, /no statically declared values/);
});

test('a second capacity label is rejected even when the selector is otherwise self-hosted', () => {
  const result = classifyRunnerSelector('[self-hosted, Linux, X64, standard, heavy]');
  assert.equal(result.kind, 'error');
  assert.match(result.message, /exactly one/);
});
