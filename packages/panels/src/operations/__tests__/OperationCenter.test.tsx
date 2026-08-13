import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createOperationRun, type OperationRunRequest } from '@forgeax/editor-product';
import {
  buildOperationCenterRows,
  projectOperationRunArtifact,
  projectRunFacts,
} from '../run-view-model';
import { operationRunFilename, serializeOperationRun } from '../run-export';

const source = readFileSync(resolve(import.meta.dir, '../OperationCenter.tsx'), 'utf8');

function run() {
  const request: OperationRunRequest = {
    runId: 'run:save:1',
    operationId: 'document.save',
    actor: { id: 'ai-1', kind: 'ai' },
    sessionId: 'session-1',
    scope: 'game:demo',
    traceId: 'trace:save:1',
    attempt: 1,
    cancellable: false,
    retryable: true,
  };
  const result = createOperationRun(request, 1);
  if (!result.ok) throw new Error(result.error.hint);
  return result.value;
}

describe('Operation Center component contract', () => {
  it('renders the product facts needed for an actionable terminal surface', () => {
    expect(source).toContain('data-testid="operation-center"');
    expect(source).toContain('runId');
    expect(source).toContain('actor');
    expect(source).toContain('parentRunId');
    expect(source).toContain('progress');
    expect(source).toContain('data-field="result"');
    expect(source).toContain('recoveryActions');
    expect(source).toContain('onAction');
    expect(source).toContain('Export JSON');
    expect(source).toContain('getSnapshot().runs');
    expect(source).toContain('profile-compare-left-input');
    expect(source).toContain('profile-compare-right-input');
    expect(source).toContain('projectProfileComparison');
    expect(source).toContain('operation-run-inspector-input');
    expect(source).toContain('operation-run-inspector-result');
    expect(source).toContain('operation-run-inspector-error');
    expect(source).toContain('projectOperationRunArtifact');
    expect(source).toContain('unavailable');
  });

  it('does not map accepted to success in the component-facing rows', () => {
    const row = buildOperationCenterRows([projectRunFacts({ run: run() })])[0];
    expect(row?.status).toBe('accepted');
    expect(row?.isSuccess).toBe(false);
  });

  it('serializes the complete OperationRun snapshot with a generic filename', () => {
    const value = run();
    expect(JSON.parse(serializeOperationRun(value))).toEqual(value);
    expect(operationRunFilename('operation-run:42/profile')).toBe('operation-run-operation-run-42-profile.json');
  });

  it('validates imported success, failed, and cancelled runs through the existing schema and read model', () => {
    const accepted = run();
    const success = {
      ...accepted,
      status: 'succeeded' as const,
      startedAt: 2,
      completedAt: 3,
      progress: { fraction: 1, stage: 'done' },
      result: { value: 'unchanged' },
    };
    const failed = {
      ...accepted,
      status: 'failed' as const,
      startedAt: 2,
      completedAt: 3,
      progress: { fraction: 0.5, stage: 'failed' },
      recoveryActions: ['operation.retry'],
      error: {
        code: 'artifact-invalid',
        hint: 'The artifact is invalid.',
        retryable: true,
        recoveryActions: ['operation.retry'],
      },
    };
    const cancelled = {
      ...accepted,
      status: 'cancelled' as const,
      cancellable: true,
      startedAt: 2,
      completedAt: 3,
      progress: { fraction: 0.25, stage: 'cancelled' },
      recoveryActions: ['operation.inspect'],
      error: {
        code: 'run-cancelled',
        hint: 'The run was cancelled.',
        retryable: false,
        recoveryActions: ['operation.inspect'],
      },
    };

    expect(projectOperationRunArtifact(success)).toMatchObject({ row: {
      runId: success.runId,
      operationId: success.operationId,
      status: 'succeeded',
      result: { value: 'unchanged' },
      isSuccess: true,
    } });
    expect(projectOperationRunArtifact(failed)).toMatchObject({ row: {
      status: 'failed',
      error: { code: 'artifact-invalid' },
      recoveryActions: ['operation.retry'],
      retryable: true,
      cancellable: false,
    } });
    expect(projectOperationRunArtifact(cancelled)).toMatchObject({ row: {
      status: 'cancelled',
      error: { code: 'run-cancelled' },
      recoveryActions: ['operation.inspect'],
      retryable: true,
      cancellable: true,
    } });
  });

  it('rejects malformed imported files without producing a success row', () => {
    expect(projectOperationRunArtifact({ runId: 'not-an-operation-run' })).toEqual({
      error: expect.objectContaining({
        code: 'operation-run-invalid',
        expected: 'a schema-valid OperationRun export',
        issues: expect.arrayContaining([expect.stringContaining('schemaVersion')]),
      }),
    });
  });
});
