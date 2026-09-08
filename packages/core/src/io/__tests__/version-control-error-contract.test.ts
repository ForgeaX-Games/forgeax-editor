import { describe, expect, test } from 'bun:test';
import {
  createVersionControlCommandError,
  VERSION_CONTROL_ERROR_CODES,
} from '../errors';

describe('version control structured error contract', () => {
  test('retains stable code, stage, correlation and recovery fields', () => {
    const error = createVersionControlCommandError({
      code: 'version-control-snapshot-stale',
      hint: 'refresh before retrying',
      stage: 'preflight',
      requestId: 'request-1',
      expected: 'snapshot-1',
      actual: 'snapshot-2',
      recoveryActions: ['version-control.refresh', 'run.retry'],
    });
    expect(error).toMatchObject({
      code: 'version-control-snapshot-stale',
      stage: 'preflight',
      requestId: 'request-1',
      expected: 'snapshot-1',
      actual: 'snapshot-2',
      recoveryActions: ['version-control.refresh', 'run.retry'],
    });
    expect(VERSION_CONTROL_ERROR_CODES).toContain('version-control-snapshot-stale');
  });

  test('normalizes unknown failures as version-control-unexpected without exposing stderr as policy', () => {
    const error = createVersionControlCommandError({
      code: 'version-control-unexpected',
      hint: 'The version control command failed.',
      stage: 'publish',
      requestId: 'request-2',
      cause: { code: 'process-exited', hint: 'bounded diagnostic' },
    });
    expect(error.code).toBe('version-control-unexpected');
    expect(error.cause).toMatchObject({ code: 'process-exited' });
    expect(error.recoveryActions).toEqual(['version-control.refresh', 'run.retry']);
  });

  test('keeps every recoverable AC failure machine-readable', () => {
    for (const code of VERSION_CONTROL_ERROR_CODES) {
      const error = createVersionControlCommandError({
        code,
        hint: `recover ${code}`,
        stage: 'm5-matrix',
        requestId: `request-${code}`,
        expected: { state: 'ready' },
        actual: { state: 'blocked' },
        recoveryActions: ['version-control.refresh'],
      });
      expect(error.code).toBe(code);
      expect(error.hint).toBe(`recover ${code}`);
      expect((error as { stage?: string }).stage).toBe('m5-matrix');
      expect(error.requestId).toBe(`request-${code}`);
      expect(error.expected).toEqual({ state: 'ready' });
      expect(error.actual).toEqual({ state: 'blocked' });
      expect(error.recoveryActions).toEqual(['version-control.refresh']);
      expect(JSON.stringify(error)).not.toContain('stderr');
    }
  });

  test('bounds process diagnostics and never makes the diagnostic text the policy', () => {
    const error = createVersionControlCommandError({
      code: 'version-control-command-failed',
      hint: 'Refresh the repository and retry.',
      cause: {
        code: 'process-exited',
        hint: 'x'.repeat(2048),
        details: { stderr: 'secret process output' },
      },
    });
    expect(error.cause).toMatchObject({ code: 'process-exited', details: { stderr: 'secret process output' } });
    expect((error.cause as { hint?: string }).hint?.length).toBe(512);
    expect(error.hint).toBe('Refresh the repository and retry.');
  });
});
