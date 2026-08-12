import { describe, expect, test } from 'bun:test';
import { findTestLayoutViolations, formatTestLayoutReport } from '../check-test-layout.mjs';

describe('editor test layout contract', () => {
  test('accepts package, app, and script tests under __tests__', () => {
    const result = findTestLayoutViolations([
      'packages/core/src/__tests__/gateway.test.ts',
      'apps/standalone/e2e/__tests__/smoke.spec.ts',
      'scripts/ci/__tests__/contract.test.mjs',
      'scripts/bench/frame.bench.ts',
    ]);

    expect(result.violations).toEqual([]);
    expect(formatTestLayoutReport([
      'packages/core/src/__tests__/gateway.test.ts',
      'scripts/bench/frame.bench.ts',
    ])).toContain('2 test-like files valid');
  });

  test('rejects colocated and legacy test directories', () => {
    const result = findTestLayoutViolations([
      'packages/core/src/gateway.test.ts',
      'packages/panels/test/panel.test.tsx',
      'scripts/ci/__test__/contract.test.mjs',
    ]);

    expect(result.violations).toEqual([
      'packages/core/src/gateway.test.ts: test-like files must live under __tests__/ or bench/',
      'packages/panels/test/panel.test.tsx: use __tests__/ instead of a singular or non-underscored test directory',
      'scripts/ci/__test__/contract.test.mjs: use __tests__/ instead of a singular or non-underscored test directory',
    ]);
  });
});
