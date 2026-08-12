import { describe, expect, it } from 'bun:test';
import { createOperationRun, type OperationRunRequest } from '@forgeax/editor-product';
import {
  buildOperationCenterRows,
  projectRunFacts,
  type OperationCenterAction,
} from '../run-view-model';

const baseRequest: OperationRunRequest = {
  runId: 'run:import:1',
  operationId: 'asset.import',
  actor: { id: 'human-1', kind: 'human' },
  sessionId: 'session-1',
  scope: 'game:demo',
  input: { subjectId: 'asset-1' },
  traceId: 'trace-1',
  parentRunId: 'run:workflow:1',
  attempt: 1,
  cancellable: true,
  retryable: true,
};

function makeRun(overrides: Partial<OperationRunRequest> = {}) {
  const result = createOperationRun({ ...baseRequest, ...overrides }, 1);
  if (!result.ok) throw new Error(result.error.hint);
  return result.value;
}

describe('Operation Center run view model', () => {
  it('keeps accepted distinct from successful terminal state', () => {
    const row = projectRunFacts({ run: makeRun() });
    expect(row.status).toBe('accepted');
    expect(row.isTerminal).toBe(false);
    expect(row.isSuccess).toBe(false);
    expect(row.actions).toEqual(['cancel']);
  });

  it('exposes terminal state, parent chain, progress, and structured error fields', () => {
    const failed = makeRun({ cancellable: false });
    const row = projectRunFacts({
      run: {
        ...failed,
        status: 'failed',
        progress: { fraction: 0.75, stage: 'commit', completed: 3, total: 4 },
        error: {
          code: 'asset-conflict',
          hint: 'Resolve the conflict before retrying.',
          subjectRef: { kind: 'asset', id: 'asset-1' },
          retryable: true,
          recoveryActions: ['asset.preflight', 'operation.retry'],
        },
        recoveryActions: ['asset.preflight', 'operation.retry'],
      },
    });

    expect(row.parentRunId).toBe('run:workflow:1');
    expect(row.progress).toEqual({ fraction: 0.75, stage: 'commit', completed: 3, total: 4 });
    expect(row.error?.code).toBe('asset-conflict');
    expect(row.error?.subjectRef).toEqual({ kind: 'asset', id: 'asset-1' });
    expect(row.actions).toEqual(['retry']);
    expect(row.actions).not.toContain('cancel');
  });

  it('derives row actions from product run facts instead of message text', () => {
    const cancelled = projectRunFacts({
      run: { ...makeRun(), status: 'cancelled', error: { code: 'cancelled', hint: 'cancelled', retryable: false, recoveryActions: [] } },
    });
    const rows = buildOperationCenterRows([cancelled]);
    const actions: OperationCenterAction[] = rows[0]?.actions ?? [];
    expect(actions).toEqual([]);
    expect(rows[0]?.status).toBe('cancelled');
    expect(rows[0]?.isSuccess).toBe(false);
  });

  it('projects placement identity, cleanup facts, and human recovery actions from the run', () => {
    const failed = makeRun({
      operationId: 'addSceneAssetToScene',
      input: { sceneGuid: 'scene-guid', name: 'Fox' },
      retryable: false,
      cancellable: false,
    });
    const row = projectRunFacts({
      run: {
        ...failed,
        status: 'failed',
        error: {
          code: 'scene-mount-failed',
          hint: 'wrapper cleanup failed',
          current: {
            requestId: 'request-1',
            sceneGuid: 'scene-guid',
            name: 'Fox',
            cleanup: { attempted: true, ok: false, wrapper: 91, error: { code: 'DESPAWN_FAILED' } },
          },
          retryable: false,
          recoveryActions: ['inspect provisional wrapper and retry cleanup'],
        },
      },
      resolveAsset: (guid) => ({ guid, kind: 'scene', name: 'Fox', sourcePath: 'assets/Fox.glb' }),
    });

    expect(row.subject).toEqual(expect.objectContaining({
      kind: 'placement',
      sceneGuid: 'scene-guid',
      selectableEntity: 91,
      sourcePaths: ['assets/Fox.glb'],
      cleanup: expect.objectContaining({ attempted: true, ok: false, wrapper: 91, errorCode: 'DESPAWN_FAILED' }),
    }));
    expect(row.actions).toEqual(['inspect', 'reveal-source']);
  });

  it('projects binding target identity for the same human/AI feedback surface', () => {
    const run = makeRun({
      operationId: 'bindAssetRef',
      input: { entity: 17, component: 'MeshRenderer', field: 'materials', guids: ['material-guid'] },
      retryable: true,
      cancellable: false,
    });
    const row = projectRunFacts({
      run: { ...run, status: 'succeeded', result: { entity: 17, guids: ['material-guid'] } },
      resolveAsset: (guid) => ({ guid, kind: 'material', name: 'Hero Material', sourcePath: 'assets/hero.material' }),
    });

    expect(row.subject).toEqual(expect.objectContaining({
      kind: 'binding',
      entity: 17,
      component: 'MeshRenderer',
      field: 'materials',
      assets: [{ guid: 'material-guid', kind: 'material', name: 'Hero Material', sourcePath: 'assets/hero.material' }],
    }));
    expect(row.actions).toEqual(['inspect', 'reveal-source']);
  });
});
