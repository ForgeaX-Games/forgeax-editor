import { describe, expect, it } from 'bun:test';
import {
  isBenignViewportRuntimeTransportError,
  mergeMonotonicImportRun,
} from '../import-run-progress-transport-poll';
import type { OperationRun } from '@forgeax/editor-core';

function run(fraction: number, stage: string): OperationRun {
  return {
    schemaVersion: 'operation-run/v1',
    runId: 'run',
    requestId: 'req',
    operationId: 'importAsset',
    status: 'running',
    actor: { id: 'human', kind: 'human' },
    sessionId: 'editor',
    scope: 'editor',
    traceId: 'trace',
    attempt: 1,
    cancellable: true,
    retryable: true,
    progress: { stage, fraction },
    recoveryActions: [],
    effectResults: {},
    acceptedAt: 1,
    sequence: 1,
  };
}

describe('import-run-progress-transport-poll', () => {
  it('mergeMonotonicImportRun keeps the higher fraction', () => {
    const merged = mergeMonotonicImportRun(run(0.4, 'cooking'), run(0.2, 'upload'));
    expect(merged.progress.fraction).toBe(0.4);
    expect(merged.progress.stage).toBe('cooking');
  });

  it('isBenignViewportRuntimeTransportError recognizes transient viewport transport faults', () => {
    expect(isBenignViewportRuntimeTransportError(new Error('viewport-runtime-disconnected'))).toBe(true);
    expect(isBenignViewportRuntimeTransportError(new Error('viewport-runtime-stale-generation'))).toBe(true);
    expect(isBenignViewportRuntimeTransportError(new Error('import-failed'))).toBe(false);
  });
});
