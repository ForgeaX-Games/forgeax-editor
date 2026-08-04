import { describe, expect, it } from 'bun:test';
import type { OperationRun } from '@forgeax/editor-core';
import { importRunToResult, isRetryableImportRun } from './import-pipeline';

function run(overrides: Partial<OperationRun>): OperationRun {
  return {
    schemaVersion: 'operation-run/v1',
    runId: 'operation-run-test',
    requestId: 'import-test',
    operationId: 'importAsset',
    actor: { id: 'human', kind: 'human' },
    sessionId: 'editor',
    scope: 'editor',
    traceId: 'operation-run-test',
    attempt: 1,
    sequence: 1,
    acceptedAt: 1,
    startedAt: 1,
    status: 'running',
    cancellable: true,
    retryable: true,
    progress: { stage: 'cooking', fraction: 0.5 },
    recoveryActions: [],
    input: { kind: 'importAsset', destPath: 'assets/logo.png', requestId: 'import-test' },
    ...overrides,
  } as OperationRun;
}

describe('import pipeline terminal projection', () => {
  it('projects the terminal result returned by the Gateway run', () => {
    expect(importRunToResult('logo.png', '/games/demo/assets/logo.png', run({
      status: 'succeeded',
      result: { filename: 'logo.png', status: 'done', guid: 'stable-guid' },
    }))).toMatchObject({ filename: 'logo.png', status: 'done', guid: 'stable-guid' });
  });

  it('preserves structured retry facts for a failed run', () => {
    expect(importRunToResult('logo.png', '/games/demo/assets/logo.png', run({
      status: 'failed',
      error: {
        code: 'IMPORT_SIDECAR_WRITE_FAILED',
        hint: 'sidecar unavailable',
        retryable: true,
        recoveryActions: ['operation.retry'],
        subjectRef: { kind: 'source-file', id: '/games/demo/assets/logo.png' },
      },
    }))).toMatchObject({
      filename: 'logo.png',
      status: 'error',
      error: 'sidecar unavailable',
      errorDetail: {
        code: 'IMPORT_SIDECAR_WRITE_FAILED',
        retryable: true,
        recoveryActions: ['operation.retry'],
      },
    });
  });

  it('projects cancellation as a non-retryable terminal result', () => {
    expect(importRunToResult('logo.png', '/games/demo/assets/logo.png', run({
      status: 'cancelled',
      error: {
        code: 'run-cancelled',
        hint: 'cancelled at the read boundary',
        retryable: false,
        recoveryActions: ['run.get'],
      },
    }))).toMatchObject({
      filename: 'logo.png',
      status: 'error',
      error: 'cancelled at the read boundary',
      errorDetail: { retryable: false },
    });
  });

  it('never offers Retry for a producer cook failure even if a stale host marks the run retryable', () => {
    expect(isRetryableImportRun(run({
      status: 'failed',
      retryable: true,
      error: {
        code: 'IMPORT_COOK_FAILED',
        hint: 'malformed GLB',
        retryable: true,
        recoveryActions: [],
      },
    }))).toBe(false);
    expect(isRetryableImportRun(run({
      status: 'failed',
      retryable: true,
      error: {
        code: 'IMPORT_NETWORK_ERROR',
        hint: 'temporary transport failure',
        retryable: true,
        recoveryActions: ['operation.retry'],
      },
    }))).toBe(true);
  });
});
