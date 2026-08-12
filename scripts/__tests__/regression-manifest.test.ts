import { expect, test } from 'bun:test';

import {
  REGRESSION_CHECKS,
  projectRegressionManifest,
  parseFixtureLayer,
  selectRegressionChecks,
} from '../regression-manifest';

const contract = await Bun.file('scripts/ci/editor-ci-contract.json').json();
const projectionFixture = await Bun.file('scripts/ci/fixtures/regression-manifest-projection.json').json();

test('fast profile is the strict contract subset and full profile is the complete contract set', () => {
  const fast = selectRegressionChecks('fast');
  const full = selectRegressionChecks('full');
  expect(fast.length).toBeGreaterThan(0);
  expect(new Set(fast.map((check) => check.fixtureLayer))).toEqual(new Set(['R0']));
  expect(new Set(full.map((check) => check.fixtureLayer))).toEqual(new Set(['R0']));
  expect(full.length).toBeGreaterThan(fast.length);
});

test('every check has stable routing and fixture selection can narrow the manifest', () => {
  expect(REGRESSION_CHECKS.every((check) =>
    check.id.length > 0 &&
    check.command.length > 0 &&
    check.args.length > 0 &&
    check.roadmapId.length > 0 &&
    check.journey.length > 0 &&
    check.gate.length > 0,
  )).toBe(true);
  expect(selectRegressionChecks('full', 'R0').map((check) => check.id)).toEqual([
    'b2-self-boot',
    'typecheck',
    'r0-hierarchy-ui-editability',
    'r0-sample-vfx-skill',
    'r0-engine-dogfood-diagnostics',
    'submodule-pin',
    'smoke-play',
  ]);
});

test('fixture layer parsing is case-insensitive and rejects unknown layers', () => {
  expect(parseFixtureLayer('r0')).toBe('R0');
  expect(parseFixtureLayer('R2')).toBe('R2');
  expect(() => parseFixtureLayer('R3')).toThrow(/expected R0, R1, or R2/);
});

test('regression manifest is a projection of the producer contract', () => {
  expect(projectRegressionManifest(contract)).toEqual(projectionFixture);
  expect(REGRESSION_CHECKS.map((check) => check.id)).toEqual(
    contract.checks.map((check: { checkId: string }) => check.checkId),
  );
});

test('local-fast is a strict contract profile subset and required contexts keep their names', () => {
  const fast = new Set(selectRegressionChecks('fast').map((check) => check.id));
  const full = new Set(selectRegressionChecks('full').map((check) => check.id));
  expect(fast.size).toBeGreaterThan(0);
  expect(fast.size).toBeLessThan(full.size);
  expect([...fast].every((checkId) => full.has(checkId))).toBe(true);
  expect(projectionFixture.requiredContexts.map((entry: { context: string }) => entry.context)).toEqual([
    'b2-self-boot',
    'typecheck',
    'submodule-pin',
    'smoke-play',
  ]);
  expect(REGRESSION_CHECKS.filter((check) => check.id.startsWith('r0-')).map((check) => check.id)).toEqual([
    'r0-hierarchy-ui-editability',
    'r0-sample-vfx-skill',
    'r0-engine-dogfood-diagnostics',
  ]);
});
