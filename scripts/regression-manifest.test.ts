import { expect, test } from 'bun:test';

import {
  REGRESSION_CHECKS,
  parseFixtureLayer,
  selectRegressionChecks,
} from './regression-manifest';

test('fast profile is the R0 PR set and full profile expands through R2', () => {
  const fast = selectRegressionChecks('fast');
  const full = selectRegressionChecks('full');
  expect(fast.length).toBeGreaterThan(0);
  expect(new Set(fast.map((check) => check.fixtureLayer))).toEqual(new Set(['R0']));
  expect(new Set(full.map((check) => check.fixtureLayer))).toEqual(new Set(['R0', 'R1', 'R2']));
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
  expect(selectRegressionChecks('full', 'R1').map((check) => check.id)).toEqual([
    'r1-true-fixture',
    'r1-placement-binding',
    'r1-play-stop-world-fork',
  ]);
});

test('fixture layer parsing is case-insensitive and rejects unknown layers', () => {
  expect(parseFixtureLayer('r0')).toBe('R0');
  expect(parseFixtureLayer('R2')).toBe('R2');
  expect(() => parseFixtureLayer('R3')).toThrow(/expected R0, R1, or R2/);
});
