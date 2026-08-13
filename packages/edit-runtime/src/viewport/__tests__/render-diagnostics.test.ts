import { describe, expect, it } from 'bun:test';
import type { RenderFeatureDiagnostics } from '@forgeax/engine-render';

import {
  createInfiniteGridDiagnosticsProvider,
  validatePerspectiveFov,
} from '../render-diagnostics';

describe('validatePerspectiveFov', () => {
  it('accepts a finite perspective field of view in radians', () => {
    expect(validatePerspectiveFov(Math.PI / 3)).toBeUndefined();
  });

  it('rejects degree-shaped and otherwise invalid projection inputs', () => {
    expect(validatePerspectiveFov(60)?.code).toBe('render-camera-invalid-projection');
    expect(validatePerspectiveFov(0)?.actual).toBe(0);
    expect(validatePerspectiveFov(Math.PI)?.actual).toBe(Math.PI);
    expect(validatePerspectiveFov(Number.NaN)?.actual).toBe(Number.NaN);
    expect(validatePerspectiveFov(Number.POSITIVE_INFINITY)?.actual).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('infinite grid diagnostics projection', () => {
  it('projects the active feature through the producer-owned provider', () => {
    const provider = createInfiniteGridDiagnosticsProvider({
      readFeatureDiagnostics: () => [{
        identity: 'editor.infinite-grid',
        order: 2,
        status: 'active',
        latestError: undefined,
      } satisfies RenderFeatureDiagnostics],
      readGeneration: () => 7,
    });

    expect(provider.snapshot()[0]).toMatchObject({
      id: 'editor-infinite-grid',
      code: 'infinite-grid-ready',
      severity: 'info',
      generation: 7,
      retryable: false,
      recoveryActions: [],
    });
  });

  it('projects generation recovery with stage, target, and retry actions', () => {
    const provider = createInfiniteGridDiagnosticsProvider({
      readFeatureDiagnostics: () => [{
        identity: 'editor.infinite-grid',
        order: 2,
        status: 'failed',
        latestError: {
          code: 'render-feature-prepared-state-mismatch',
          expected: 'prepared resources belong to the active generation',
          hint: 'Prepared render state is stale; retry on the next frame.',
          detail: {
            featureIdentity: 'editor.infinite-grid',
            order: 2,
            stage: 'contribute',
            operation: 'validate-prepared-generation',
            resourceKind: 'bindings',
            reason: 'generation-mismatch',
            expectedGeneration: 3,
            actualGeneration: 4,
            recovery: 'next-frame',
          },
        },
      } satisfies RenderFeatureDiagnostics],
    });

    expect(provider.snapshot()[0]).toMatchObject({
      code: 'render-feature-prepared-state-mismatch',
      severity: 'warn',
      stage: 'contribute',
      generation: 4,
      recovery: 'next-frame',
      retryable: true,
      recoveryActions: ['run.wait', 'run.retry'],
      detail: {
        status: 'failed',
        recovery: 'next-frame',
        error: {
          detail: {
            reason: 'generation-mismatch',
            actualGeneration: 4,
          },
        },
      },
    });
  });
});
