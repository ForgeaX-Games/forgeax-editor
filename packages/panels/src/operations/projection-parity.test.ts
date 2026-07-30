import { describe, expect, it } from 'bun:test';
import {
  createOperationRun,
  type AuthoredCommit,
  type OperationRunRequest,
} from '@forgeax/editor-product';
import { projectRunFacts } from './run-view-model';

const request: OperationRunRequest = {
  runId: 'run:rename:1',
  operationId: 'asset.rename',
  actor: { id: 'agent-1', kind: 'ai' },
  sessionId: 'session-1',
  scope: 'game:demo',
  input: { subjectId: 'asset-1', expectedRevision: 'workspace:r4' },
  traceId: 'trace-1',
  parentRunId: 'run:workflow:1',
  attempt: 1,
  cancellable: false,
  retryable: true,
};

const commit: AuthoredCommit = {
  schemaVersion: 'authored-commit/v1',
  runId: request.runId,
  operationId: request.operationId,
  actor: request.actor,
  revision: 'workspace:r5',
  result: { subjectId: 'asset-1' },
};

function acceptedRun() {
  const result = createOperationRun(request, 10);
  if (!result.ok) throw new Error(result.error.hint);
  return result.value;
}

describe('common product fact projection', () => {
  it('keeps UI and AI projections identical for the same run and commit', () => {
    const run = acceptedRun();
    const ui = projectRunFacts({ run, commit });
    const ai = projectRunFacts({ run, commit });

    expect(ui).toEqual(ai);
    expect(ui.runId).toBe(request.runId);
    expect(ui.operationId).toBe(request.operationId);
    expect(ui.subjectId).toBe('asset-1');
    expect(ui.revision).toBe('workspace:r5');
    expect(ui.status).toBe('accepted');
    expect(ui.isSuccess).toBe(false);
  });

  it('does not lose structured errors or recovery actions', () => {
    const run = acceptedRun();
    const runError = {
      code: 'revision-conflict',
      hint: 'Refresh the workspace before retrying.',
      expected: 'workspace:r4',
      current: 'workspace:r5',
      retryable: false,
      recoveryActions: ['asset.preflight'],
    };
    const failed = projectRunFacts({
      run: {
        ...run,
        status: 'failed',
        error: runError,
        recoveryActions: ['asset.preflight'],
      },
    });

    expect(failed.error).toEqual(expect.objectContaining({
      code: 'revision-conflict',
      expected: 'workspace:r4',
      current: 'workspace:r5',
    }));
    expect(failed.recoveryActions).toEqual(['asset.preflight']);
    expect(failed.isSuccess).toBe(false);
  });
});
