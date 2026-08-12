import { expect, test } from 'bun:test';

import {
  REGRESSION_CHECKS,
  projectRegressionManifest,
  selectRegressionChecks,
} from '../regression-manifest';

const contract = await Bun.file('scripts/ci/editor-ci-contract.json').json();
const fixture = await Bun.file('scripts/ci/fixtures/regression-manifest-projection.json').json();

test('contract projection preserves identity and owner home fields', () => {
  expect(projectRegressionManifest(contract)).toEqual(fixture);
  expect(REGRESSION_CHECKS.every((check) => check.owner === 'editor-ci')).toBe(true);
  expect(REGRESSION_CHECKS.every((check) => Object.keys(check.executionHome).length === 6)).toBe(true);
});

test('local-fast is a strict subset of local-full', () => {
  const fast = new Set(selectRegressionChecks('fast').map((check) => check.id));
  const full = new Set(selectRegressionChecks('full').map((check) => check.id));
  expect(fast.size).toBeLessThan(full.size);
  expect([...fast].every((checkId) => full.has(checkId))).toBe(true);
});

test('required contexts remain the migration-era names', () => {
  expect(fixture.requiredContexts.map((entry: { context: string }) => entry.context)).toEqual([
    'b2-self-boot',
    'typecheck',
    'submodule-pin',
    'smoke-play',
  ]);
});

test('mainline R0 checks are complete local-only contract entries', () => {
  const checkIds = ['r0-hierarchy-ui-editability', 'r0-sample-vfx-skill', 'r0-engine-dogfood-diagnostics'];
  for (const checkId of checkIds) {
    const check = REGRESSION_CHECKS.find((candidate) => candidate.id === checkId);
    expect(check).toBeDefined();
    expect(check?.owner).toBe('editor-ci');
    expect(check?.profiles).toEqual(['fast', 'full']);
    expect(check?.executionHome).toEqual({
      'local-fast': true,
      'local-full': true,
      PR: false,
      main: false,
      'nightly/scheduled': false,
      'post-merge': false,
    });
    expect(fixture.requiredContexts.some((entry: { checkId: string }) => entry.checkId === checkId)).toBe(false);
  }
});
