import { expect, test } from 'bun:test';
import { projectRuntimeDiagnostic } from '../runtime-diagnostic';

test('public recovery diagnostics preserve structured producer cause arrays through JSON', () => {
  const failure = {
    code: 'scan-failed',
    cause: [{
      code: 'produce-failed',
      cause: {
        code: 'pack-source-external-closure-mismatch',
        expected: 'external declarations to equal referenced assets',
        hint: 'Repair source declarations before rebuilding.',
        detail: {
          sourcePath: '/project/assets/scene.pack.ts',
          unusedDeclaredGuids: ['019fb7ce-3300-7000-8000-000000000007'],
          secret: 'should-not-cross-the-wire',
        },
        stack: 'private stack',
      },
    }],
  };
  const wire = JSON.parse(JSON.stringify(projectRuntimeDiagnostic(failure, '/project')));
  expect(wire.cause).toEqual([{
    code: 'produce-failed',
    cause: {
      code: 'pack-source-external-closure-mismatch',
      expected: failure.cause[0]!.cause.expected,
      hint: failure.cause[0]!.cause.hint,
      detail: {
        sourcePath: './assets/scene.pack.ts',
        unusedDeclaredGuids: ['019fb7ce-3300-7000-8000-000000000007'],
      },
    },
  }]);
});

test('cause arrays remain bounded and tolerate cycles', () => {
  const cyclic: { code: string; cause?: unknown } = { code: 'cycle' };
  cyclic.cause = [cyclic];
  expect(() => JSON.stringify(projectRuntimeDiagnostic(cyclic))).not.toThrow();
  const result = projectRuntimeDiagnostic({ code: 'scan-failed', cause: Array.from({ length: 120 }, () => ({ code: 'source-failed' })) });
  expect(Array.isArray(result.cause)).toBe(true);
  expect((result.cause as unknown[]).length).toBeLessThanOrEqual(100);
});
