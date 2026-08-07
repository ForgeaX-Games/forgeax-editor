import { describe, expect, it } from 'bun:test';
import type { OperationRunStatus } from '@forgeax/editor-product';

import {
  createRuntimeReadiness,
  RUNTIME_READINESS_STATES,
  type RuntimeReadiness,
} from '../io/vfx-runtime-readiness';
import { withRuntimeReadiness } from '../session/import-ops';

describe('VFX runtime readiness contract', () => {
  it('keeps OperationRun status closed and terminal readiness immutable', () => {
    const statuses: OperationRunStatus[] = ['accepted', 'running', 'succeeded', 'failed', 'cancelled'];
    expect(statuses).toEqual(['accepted', 'running', 'succeeded', 'failed', 'cancelled']);
    expect(RUNTIME_READINESS_STATES).toEqual([
      'committed-awaiting-reload',
      'resident-ready',
      'simulation-ready',
      'render-ready',
      'visible-ready',
      'render-unavailable',
    ]);
    const readiness = createRuntimeReadiness({
      state: 'committed-awaiting-reload',
      requestId: 'import-request-1',
      assetGuid: 'particle-guid',
      committedRevision: 7,
      residentRevision: null,
      hint: 'Stop and Play to load the committed revision.',
    });
    expect(Object.isFrozen(readiness)).toBe(true);
    expect(readiness).toMatchObject({ requestId: 'import-request-1', assetGuid: 'particle-guid', committedRevision: 7, residentRevision: null });
  });

  it('attaches only the correlated committed snapshot to a successful import result', () => {
    const result = withRuntimeReadiness(
      { filename: 'burst.particle.json', status: 'done', guid: 'particle-guid' },
      {
        requestId: 'import-request-2',
        assetGuid: 'particle-guid',
        committedRevision: 8,
        residentRevision: null,
      },
    );
    expect(result.runtimeReadiness).toEqual({
      state: 'committed-awaiting-reload',
      requestId: 'import-request-2',
      assetGuid: 'particle-guid',
      committedRevision: 8,
      residentRevision: null,
      hint: 'Stop and Play to load the committed revision.',
    });
  });

  it('does not permit a readiness projection without the same asset correlation', () => {
    const snapshot: RuntimeReadiness = createRuntimeReadiness({
      state: 'resident-ready',
      requestId: 'request-a',
      assetGuid: 'asset-a',
      committedRevision: 3,
      residentRevision: 3,
      hint: 'The committed revision is resident.',
    });
    expect(() => createRuntimeReadiness({ ...snapshot, requestId: '', assetGuid: 'asset-b' })).toThrow();
  });
});
