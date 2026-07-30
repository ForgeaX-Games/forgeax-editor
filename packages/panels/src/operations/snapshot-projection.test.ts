import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createOperationRun, type OperationRunRequest } from '@forgeax/editor-product';
import {
  getOperationCenterRows,
  type OperationProjectionSource,
  type OperationRunProjectionSnapshot,
} from './run-view-model';

const request: OperationRunRequest = {
  runId: 'run:projection:1',
  requestId: 'request:projection:1',
  operationId: 'document.save',
  actor: { id: 'ai-1', kind: 'ai' },
  sessionId: 'session-1',
  scope: 'game:demo',
  traceId: 'trace:projection:1',
  attempt: 1,
  cancellable: false,
  retryable: true,
};

describe('versioned terminal projection source', () => {
  it('derives UI rows from the same snapshot an AI/eval reader polls', () => {
    const created = createOperationRun(request, 1);
    if (!created.ok) throw new Error(created.error.hint);
    const terminal = {
      ...created.value,
      status: 'failed' as const,
      result: { bytes: 0 },
      error: {
        code: 'write-failed',
        hint: 'The save target rejected the write.',
        retryable: true,
        recoveryActions: ['operation.retry'],
      },
      recoveryActions: ['operation.retry'],
    };
    const snapshot = Object.freeze({ revision: 7, runs: Object.freeze([Object.freeze(terminal)]) });
    let getSnapshotCalls = 0;
    const source: OperationProjectionSource = {
      getSnapshot: () => {
        getSnapshotCalls += 1;
        return snapshot;
      },
    };

    const aiRead = source.getSnapshot();
    const uiRow = getOperationCenterRows(source)[0];

    expect(getSnapshotCalls).toBe(2);
    expect(uiRow).toMatchObject({
      runId: aiRead.runs[0]!.runId,
      requestId: aiRead.runs[0]!.requestId,
      status: aiRead.runs[0]!.status,
      result: aiRead.runs[0]!.result,
      error: aiRead.runs[0]!.error,
      recoveryActions: aiRead.runs[0]!.recoveryActions,
      isTerminal: true,
      isSuccess: false,
    });
  });

  it('uses the snapshot revision for cache invalidation when no legacy revision exists', () => {
    const first = createOperationRun(request, 1);
    if (!first.ok) throw new Error(first.error.hint);
    let current: OperationRunProjectionSnapshot = Object.freeze({ revision: 1, runs: Object.freeze([first.value]) });
    const source: OperationProjectionSource = {
      getSnapshot: () => current,
    };

    const firstRows = getOperationCenterRows(source);
    current = Object.freeze({ revision: 2, runs: Object.freeze([{ ...first.value, status: 'succeeded' as const }]) });
    const secondRows = getOperationCenterRows(source);

    expect(secondRows).not.toBe(firstRows);
    expect(secondRows[0]?.status).toBe('succeeded');
  });

  it('keeps raw snapshot inputs out of the derived rows cache', () => {
    const source = readFileSync(resolve(import.meta.dir, 'run-view-model.ts'), 'utf8');
    expect(source).toContain('readonly revision: number;');
    expect(source).not.toContain('readonly runs: readonly (OperationRun | OperationRunFactProjection)[];');
    expect(source).not.toContain('readonly commits: readonly AuthoredCommit[];');
    expect(source).toContain('rowsCache = { source, revision, rows };');
  });
});
