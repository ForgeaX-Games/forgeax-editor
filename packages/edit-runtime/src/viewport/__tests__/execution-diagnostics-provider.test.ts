import { describe, expect, test } from 'bun:test';
import type { ExecutionControl, ExecutionReport } from '@forgeax/engine-app';
import { createEngineExecutionDiagnostics } from '../execution-diagnostics-provider';

function report(patch: Partial<ExecutionReport> = {}): ExecutionReport {
  return {
    schemaVersion: 2,
    workers: {
      engine: { requested: 'auto', enabled: true, reason: 'enabled', missingCapabilities: [] },
      render: { requested: 'auto', enabled: false, reason: 'capability-unavailable', missingCapabilities: ['workerWebGpu'] },
      kernels: { requested: 'auto', enabled: false, reason: 'capability-unavailable', missingCapabilities: ['sharedArrayBuffer'] },
    },
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
    frame: { submitted: 0, completed: 0, inFlight: 0, highWater: 0, throttledTicks: 0 },
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
      code: 'engine-execution-worker',
      title: 'Engine execution: worker',
      detail: { unavailableCapabilities: ['crossOriginIsolated', 'sharedArrayBuffer'] },
    });

    current = report({
      engine: { realm: 'host', health: 'running' },
      workers: { ...current.workers, engine: { requested: false, enabled: false, reason: 'disabled', missingCapabilities: [] } },
    });
    expect(bridge.report().engine.realm).toBe('host');
    expect(bridge.provider.snapshot()[0]?.title).toBe('Engine execution: host');
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
