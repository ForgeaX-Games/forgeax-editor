import { describe, expect, test } from 'bun:test';
import type { ExecutionControl, ExecutionReport } from '@forgeax/engine-app';
import { createEngineExecutionDiagnostics } from '../execution-diagnostics-provider';

function report(patch: Partial<ExecutionReport> = {}): ExecutionReport {
  return {
    schemaVersion: 1,
    requestedTier: 'auto',
    actualTier: 'engine-worker',
    selectionReason: 'auto-engine-worker',
    sharedEvidencePassed: false,
    capabilities: {
      worker: { available: true, reason: 'available' },
      offscreenCanvas: { available: true, reason: 'available' },
      workerAnimationFrame: { available: true, reason: 'available' },
      workerWebGpu: { available: true, reason: 'available' },
      crossOriginIsolated: { available: false, reason: 'missing headers' },
      sharedArrayBuffer: { available: false, reason: 'unavailable' },
      atomicsWait: { available: true, reason: 'available' },
    },
    engine: { realm: 'worker', health: 'running' },
    world: { identity: 'world-1', health: 'healthy', partialWrite: false, retryable: false },
    kernelDispatch: { eligible: false, usedShared: false, reason: 'no-eligible-kernel', dispatched: 0, completed: 0 },
    performance: { hostFrameMs: null, engineUpdateMs: null, kernelWaitMs: null, hostAudioMs: null },
    audio: { owner: 'host', contextState: 'suspended', activeSourceCount: 0, lastError: null },
    fault: null,
    ...patch,
  };
}

describe('engine execution diagnostics projection', () => {
  test('reads the current producer report without retaining a copy', () => {
    let current = report();
    const control = { report: () => current } as ExecutionControl;
    const bridge = createEngineExecutionDiagnostics(control);

    expect(bridge.provider.snapshot()[0]).toMatchObject({
      severity: 'info',
      code: 'engine-execution-engine-worker',
      title: 'Engine execution: engine-worker',
      detail: { unavailableCapabilities: ['crossOriginIsolated', 'sharedArrayBuffer'] },
    });

    current = report({ actualTier: 'shared', selectionReason: 'auto-shared', sharedEvidencePassed: true });
    expect(bridge.report().actualTier).toBe('shared');
    expect(bridge.provider.snapshot()[0]?.title).toBe('Engine execution: shared');
  });

  test('projects producer faults as retry-aware errors', () => {
    const current = report({
      engine: { realm: 'worker', health: 'faulted' },
      world: { identity: 'world-1', health: 'poisoned', partialWrite: true, retryable: true },
      fault: {
        source: 'kernel',
        code: 'kernel-partial-write',
        expected: 'no partial writes',
        hint: 'Rebuild the World.',
        detail: {},
        partialWrite: true,
        retryable: true,
      },
    });
    const bridge = createEngineExecutionDiagnostics({ report: () => current } as ExecutionControl);
    expect(bridge.provider.snapshot()[0]).toMatchObject({
      severity: 'error',
      code: 'kernel-partial-write',
      retryable: true,
    });
  });
});
