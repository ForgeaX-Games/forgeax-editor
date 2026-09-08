import { describe, expect, it } from 'bun:test';
import type { RenderFeatureDiagnostics } from '@forgeax/engine-render';
import type { MaterialLoadError, MaterialReady } from '@forgeax/engine-assets-runtime';

import {
  createMaterialPublicationBinding,
  createInfiniteGridDiagnosticsProvider,
  projectMaterialPublicationDiagnostic,
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

describe('material publication diagnostics projection', () => {
  it('projects owner fields without parsing the error message', () => {
    expect(projectMaterialPublicationDiagnostic({
      materialGuid: 'material-guid',
      specializationKey: 'spec-key',
      publicationGeneration: 7,
      error: {
        code: 'asset-artifact-integrity-mismatch',
        expected: 'sha256:expected',
        actual: 'sha256:actual',
        hint: 'Republish the material.',
        retryable: true,
        recoveryActions: ['material.republish'],
      },
    })).toMatchObject({
      code: 'asset-artifact-integrity-mismatch',
      assetGuid: 'material-guid',
      expected: 'sha256:expected',
      actual: 'sha256:actual',
      retryable: true,
      recoveryActions: ['material.republish'],
    });
  });

  it('binds inspection and diagnostics to the production MaterialReady map', () => {
    const ready = {
      status: 'Ready',
      guid: 'material-guid',
      materialGuid: 'material-guid',
      publicationGeneration: 7,
      specializationKey: 'spec-key',
      sourceClosure: ['materials/example.pack.json', 'materials/example.wgsl'],
      artifactDigest: 'sha256:artifact',
      parameterContract: { parameters: [{ name: 'baseColor', type: 'color' }], values: {} },
      record: { receipt: { inputDigest: 'sha256:source' } },
      artifact: {},
    } as unknown as MaterialReady;
    const error = {
      status: 'Error',
      error: {
        code: 'asset-artifact-integrity-mismatch',
        expected: 'sha256:expected',
        actual: 'sha256:actual',
        hint: 'Republish the material.',
        retryable: true,
        recoveryActions: ['material.republish'],
        detail: { guid: 'broken-guid', specializationKey: 'spec-key', publicationGeneration: 8 },
      },
    } as unknown as MaterialLoadError;
    const readiness = new Map<string, MaterialReady | MaterialLoadError>([
      ['material-guid', ready],
      ['broken-guid', error],
    ]);
    const binding = createMaterialPublicationBinding(
      {
        getMaterialReadiness: (guid) => readiness.get(guid),
        materialReadiness: readiness,
      },
      { url: 'http://localhost:15290/', host: 'editor' },
    );

    expect(binding.readMaterialInspection('material-guid')).toMatchObject({
      ok: true,
      materialGuid: 'material-guid',
      publicationGeneration: 7,
      sourceClosure: [
        { module: 'materials/example.pack.json', digest: 'sha256:source' },
        { module: 'materials/example.wgsl', digest: 'sha256:source' },
      ],
      transport: { url: 'http://localhost:15290/', host: 'editor' },
    });
    expect(binding.diagnosticsProvider.snapshot()[0]).toMatchObject({
      code: 'asset-artifact-integrity-mismatch',
      assetGuid: 'broken-guid',
      generation: 8,
      recoveryActions: ['material.republish'],
    });
  });
});
