import { describe, expect, test } from 'bun:test';
import {
  VIEWPORT_RUNTIME_CONTRACT_VERSION,
  isCurrentViewportRuntime,
  isViewportProjectionEnvelope,
  isViewportRuntimeIdentity,
  type ViewportRuntimeIdentity,
} from '../viewport-runtime';

const runtime: ViewportRuntimeIdentity = {
  version: VIEWPORT_RUNTIME_CONTRACT_VERSION,
  runtimeId: 'edit-runtime',
  runtimeGeneration: 2,
  carrierId: 'docked-viewport',
  carrierKind: 'iframe',
};

describe('viewport runtime contract', () => {
  test('keeps runtime generation separate from replaceable carrier metadata', () => {
    expect(isViewportRuntimeIdentity(runtime)).toBe(true);
    expect(isViewportRuntimeIdentity({ ...runtime, runtimeGeneration: 0 })).toBe(false);
    expect(isViewportRuntimeIdentity({ ...runtime, carrierKind: 'panel-iframe' })).toBe(false);
  });

  test('fences delayed messages from an older runtime generation', () => {
    expect(isCurrentViewportRuntime(runtime, runtime)).toBe(true);
    expect(isCurrentViewportRuntime(runtime, { runtimeId: runtime.runtimeId, runtimeGeneration: 1 })).toBe(false);
    expect(isCurrentViewportRuntime(runtime, { runtimeId: 'other-runtime', runtimeGeneration: 2 })).toBe(false);
  });

  test('distinguishes a real empty projection from unavailable and faulted states', () => {
    expect(isViewportProjectionEnvelope({
      version: VIEWPORT_RUNTIME_CONTRACT_VERSION,
      runtime,
      revision: 0,
      status: 'empty',
    })).toBe(true);
    expect(isViewportProjectionEnvelope({
      version: VIEWPORT_RUNTIME_CONTRACT_VERSION,
      runtime,
      revision: 1,
      status: 'unavailable',
      error: { code: 'runtime-unavailable', hint: 'Reconnect the active carrier.', retryable: true, recoveryActions: ['runtime.reconnect'] },
    })).toBe(true);
    expect(isViewportProjectionEnvelope({
      version: VIEWPORT_RUNTIME_CONTRACT_VERSION,
      runtime,
      revision: 2,
      status: 'ready',
    })).toBe(false);
  });
});
