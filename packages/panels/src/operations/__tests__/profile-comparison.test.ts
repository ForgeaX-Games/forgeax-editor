import { describe, expect, it } from 'bun:test';
import { createOperationRun } from '@forgeax/editor-product';
import { projectProfileComparison } from '../../operation-projection';

function capture(captureId: string, variant: 'left' | 'right' = 'left'): Record<string, unknown> {
  const right = variant === 'right';
  return {
    schemaVersion: '1.0',
    captureId,
    timeUnit: 'microseconds',
    frameLimit: 4,
    eventLimit: 16,
    phaseCatalog: {
      app: ['input', 'update'],
      render: right ? ['submit', 'gpu'] : ['submit'],
    },
    records: right
      ? [
        { kind: 'phase', source: 'app', frameId: 1, phase: 'input', startMicros: 0, endMicros: 15, durationMicros: 15 },
        { kind: 'phase', source: 'app', frameId: 1, phase: 'update', parentSource: 'app', parentPhase: 'input', startMicros: 15, endMicros: 40, durationMicros: 25 },
        { kind: 'phase', source: 'render', frameId: 1, phase: 'submit', startMicros: 40, endMicros: 45, durationMicros: 5 },
        { kind: 'phase', source: 'render', frameId: 2, phase: 'gpu', startMicros: 50, endMicros: 90, durationMicros: 40 },
      ]
      : [
        { kind: 'phase', source: 'app', frameId: 1, phase: 'input', startMicros: 0, endMicros: 10, durationMicros: 10 },
        { kind: 'phase', source: 'app', frameId: 1, phase: 'update', parentSource: 'app', parentPhase: 'input', startMicros: 10, endMicros: 30, durationMicros: 20 },
        { kind: 'skip', source: 'render', frameId: 1, phase: 'submit', reason: 'not recorded' },
      ],
    completeness: right
      ? { status: 'overflow', retainedEventCount: 4, droppedEventCount: 2, firstAffectedFrameId: 2, lastAffectedFrameId: 2 }
      : { status: 'complete', retainedEventCount: 3, droppedEventCount: 0 },
  };
}

function succeededRun(runId: string, result: unknown) {
  const accepted = createOperationRun({
    runId,
    requestId: `request-${runId}`,
    operationId: 'captureCpuProfile',
    actor: { id: 'ai-compare', kind: 'ai' },
    sessionId: 'session-compare',
    scope: 'editor:compare',
    traceId: `trace-${runId}`,
    cancellable: false,
    retryable: false,
  }, 1);
  if (!accepted.ok) throw new Error(accepted.error.hint);
  return {
    ...accepted.value,
    status: 'succeeded' as const,
    progress: { fraction: 1, stage: 'completed' },
    startedAt: 2,
    completedAt: 3,
    result,
    sequence: 3,
  };
}

describe('profile comparison projection', () => {
  it('derives a union of full Engine phase identities and preserves completeness facts', () => {
    const projection = projectProfileComparison(
      succeededRun('run-left', capture('capture-0001')),
      succeededRun('run-right', capture('capture-0002', 'right')),
    );

    expect(projection.left.summary).toMatchObject({
      runId: 'run-left',
      captureId: 'capture-0001',
      timeUnit: 'microseconds',
      frameCount: 1,
      recordCount: 3,
      phaseCount: 2,
      skipCount: 1,
      completeness: { status: 'complete', retainedEventCount: 3, droppedEventCount: 0 },
    });
    expect(projection.right.summary).toMatchObject({
      runId: 'run-right',
      captureId: 'capture-0002',
      completeness: { status: 'overflow', retainedEventCount: 4, droppedEventCount: 2, firstAffectedFrameId: 2, lastAffectedFrameId: 2 },
    });

    const update = projection.phases.find((phase) => phase.identity.phase === 'update');
    expect(update).toEqual({
      identity: { source: 'app', phase: 'update', parentSource: 'app', parentPhase: 'input' },
      left: { count: 1, skipCount: 0, p95DurationMicros: 20 },
      right: { count: 1, skipCount: 0, p95DurationMicros: 25 },
      delta: { count: 0, skipCount: 0, p95DurationMicros: 5 },
    });

    const submit = projection.phases.find((phase) => phase.identity.source === 'render' && phase.identity.phase === 'submit');
    expect(submit).toEqual({
      identity: { source: 'render', phase: 'submit' },
      left: { count: 0, skipCount: 1, p95DurationMicros: null },
      right: { count: 1, skipCount: 0, p95DurationMicros: 5 },
      delta: { count: 1, skipCount: -1 },
    });

    const gpu = projection.phases.find((phase) => phase.identity.phase === 'gpu');
    expect(gpu).toMatchObject({
      identity: { source: 'render', phase: 'gpu' },
      right: { count: 1, p95DurationMicros: 40 },
    });
    expect(gpu?.left).toBeUndefined();
    expect(gpu?.delta).toBeUndefined();
  });

  it('is stable under reversed inputs and does not coerce unavailable values to zero', () => {
    const left = succeededRun('run-left', capture('capture-0001'));
    const right = succeededRun('run-right', capture('capture-0002', 'right'));
    const normal = projectProfileComparison(left, right);
    const reversed = projectProfileComparison(right, left);

    expect(reversed.phases.map((phase) => phase.identity)).toEqual(normal.phases.map((phase) => phase.identity));
    const normalUpdate = normal.phases.find((phase) => phase.identity.phase === 'update');
    const reversedUpdate = reversed.phases.find((phase) => phase.identity.phase === 'update');
    expect(reversedUpdate?.left).toEqual(normalUpdate?.right);
    expect(reversedUpdate?.right).toEqual(normalUpdate?.left);
    const submit = normal.phases.find((phase) => phase.identity.source === 'render' && phase.identity.phase === 'submit');
    expect(submit?.left?.p95DurationMicros).toBeNull();
    expect(submit?.delta?.p95DurationMicros).toBeUndefined();
  });

  it('keeps independent OperationRun and Engine-owner errors on their own side', () => {
    const valid = succeededRun('run-valid', capture('capture-0003'));
    const invalidRun = projectProfileComparison({}, valid);
    expect(invalidRun.left).toMatchObject({ error: { code: 'operation-run-invalid' } });
    expect(invalidRun.right.summary?.captureId).toBe('capture-0003');

    const engineRejected = projectProfileComparison(
      succeededRun('run-engine-invalid', { schemaVersion: '9.0' }),
      valid,
    );
    expect(engineRejected.left).toMatchObject({
      run: { runId: 'run-engine-invalid' },
      error: {
        code: 'profile-artifact-incompatible',
        expected: 'a schema-valid ProfileCapture v1 artifact',
        detail: { path: '/schemaVersion' },
      },
    });
    expect(engineRejected.right.summary?.captureId).toBe('capture-0003');
    expect(engineRejected.phases).toHaveLength(3);
    expect(engineRejected.phases.every((phase) => phase.left === undefined)).toBe(true);
    expect(engineRejected.phases.every((phase) => phase.right !== undefined)).toBe(true);
  });

  it('rejects non-succeeded or result-less runs without inventing a profile model', () => {
    const accepted = createOperationRun({
      runId: 'run-accepted',
      operationId: 'captureCpuProfile',
      actor: { id: 'ai-compare', kind: 'ai' },
      sessionId: 'session-compare',
      scope: 'editor:compare',
      traceId: 'trace-accepted',
    }, 1);
    if (!accepted.ok) throw new Error(accepted.error.hint);
    const noResult = succeededRun('run-no-result', undefined);

    expect(projectProfileComparison(accepted.value, noResult).left.error).toMatchObject({
      code: 'operation-run-not-succeeded',
      detail: { status: 'accepted' },
    });
    expect(projectProfileComparison(noResult, noResult).left.error).toMatchObject({
      code: 'operation-run-result-missing',
    });
  });

  it('does not mutate imported artifacts', () => {
    const left = succeededRun('run-left', capture('capture-0001'));
    const right = succeededRun('run-right', capture('capture-0002', 'right'));
    const beforeLeft = JSON.stringify(left);
    const beforeRight = JSON.stringify(right);
    projectProfileComparison(left, right);
    expect(JSON.stringify(left)).toBe(beforeLeft);
    expect(JSON.stringify(right)).toBe(beforeRight);
  });
});
