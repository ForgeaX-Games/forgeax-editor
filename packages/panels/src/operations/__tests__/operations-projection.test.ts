import { describe, expect, it } from 'bun:test';
import { createOperationRun, reduceOperationRun, type OperationRun } from '@forgeax/editor-product';
import {
  projectOperationsPage,
  type OperationsPageRun,
} from '../operations-projection';

function run(): OperationRun {
  const created = createOperationRun({
    runId: 'run-1',
    requestId: 'request-1',
    operationId: 'material.preview',
    actor: { id: 'ai-1', kind: 'ai' },
    sessionId: 'ai-session',
    scope: 'private',
    input: { subjectGuid: 'mat-1' },
    traceId: 'trace-1',
    cancellable: true,
    retryable: true,
  }, 10);
  if (!created.ok) throw new Error('fixture run failed');
  const running = reduceOperationRun(created.value, { type: 'running', runId: 'run-1', sequence: 2, at: 11 });
  if (!running.ok) throw new Error('fixture running transition failed');
  const progress = reduceOperationRun(running.value, {
    type: 'progress', runId: 'run-1', sequence: 3, at: 12,
    progress: { fraction: 0.5, stage: 'capture', completed: 1, total: 2 },
  });
  if (!progress.ok) throw new Error('fixture progress transition failed');
  const terminal = reduceOperationRun(progress.value, {
    type: 'succeeded', runId: 'run-1', sequence: 4, at: 13,
    result: {
      subject: { kind: 'MaterialAsset', guid: 'mat-1' },
      snapshot: { revision: 7, digest: 'sha256:mat-7' },
      artifacts: [{ kind: 'png', uri: 'artifact://run-1.png' }],
      diagnostics: [{ code: 'preview-ok', severity: 'info', message: 'captured' }],
    },
  });
  if (!terminal.ok) throw new Error('fixture terminal transition failed');
  return terminal.value;
}

describe('Operations Page POD projection', () => {
  it('preserves run identity, actor, subject, snapshot, progress, terminal, artifacts and diagnostics', () => {
    const projection = projectOperationsPage({ revision: 9, runs: [run()] });
    expect(projection.schemaVersion).toBe('operations-page/v1');
    expect(projection.revision).toBe(9);
    expect(projection.runs).toHaveLength(1);
    expect(projection.runs[0]).toMatchObject({
      runId: 'run-1', requestId: 'request-1', operationId: 'material.preview',
      actor: { id: 'ai-1', kind: 'ai' }, sessionId: 'ai-session', scope: 'private',
      subject: { kind: 'MaterialAsset', guid: 'mat-1' },
      snapshot: { revision: 7, digest: 'sha256:mat-7' },
      progress: { fraction: 1, stage: 'succeeded' },
      terminal: { status: 'succeeded' },
      artifacts: [{ kind: 'png', uri: 'artifact://run-1.png' }],
      diagnostics: [{ code: 'preview-ok' }],
    } satisfies Partial<OperationsPageRun>);
  });

  it('projects only GUID navigation for an authored subject', () => {
    const projection = projectOperationsPage({ revision: 1, runs: [run()] });
    expect(projection.runs[0]?.controls).toEqual([{ kind: 'open-resource', guid: 'mat-1' }]);
  });
});
