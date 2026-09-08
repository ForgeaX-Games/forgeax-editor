import { describe, expect, test } from 'bun:test';
import { VagCarrierHeartbeatSchema } from '@forgeax/editor-core/protocol';
import { toVagExecutionEnvelope } from '../vag-execution-envelope';

const fatReport = {
  schemaVersion: 1 as const,
  requestedTier: 'auto' as const,
  actualTier: 'main-serial' as const,
  selectionReason: 'auto-main-serial' as const,
  sharedEvidencePassed: false,
  capabilities: { worker: { available: false, reason: 'test' } },
  engine: { realm: 'host' as const, health: 'running' as const },
  world: { identity: 'world-a', health: 'healthy', partialWrite: false, retryable: false },
  kernelDispatch: {
    eligible: false, usedShared: false, reason: 'forced-inline' as const, dispatched: 0, completed: 0,
  },
  performance: {
    hostFrameMs: null, engineUpdateMs: null, kernelWaitMs: null, hostAudioMs: null,
  },
  audio: {
    owner: 'host' as const, contextState: 'running' as const, activeSourceCount: 0, lastError: null,
  },
  fault: {
    source: 'runtime' as const,
    code: 'renderer-error',
    expected: 'alive',
    hint: 'inspect the renderer',
    detail: { extra: true },
    partialWrite: false,
    retryable: true,
  },
};

const heartbeatBase = {
  version: 1 as const,
  runtimeId: 'runtime-a',
  runtimeGeneration: 4,
  carrierId: 'carrier-a:play',
  carrierKind: 'iframe' as const,
  challengeResponse: null,
  scope: null,
  pageNonce: 'page-a',
  pageIdentity: 'http://127.0.0.1:18810/preview/',
  canvasIdentity: 'canvas-a',
  rendererIdentity: 'renderer-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  rendererGeneration: 1,
  sentinel: 1,
  liveness: 'alive' as const,
  renderReadiness: 'ready' as const,
  failure: null,
};

describe('VAG execution envelope', () => {
  test('projects a fat engine ExecutionReport onto the carrier wire subset', () => {
    expect(toVagExecutionEnvelope(fatReport)).toEqual({
      schemaVersion: 1,
      requestedTier: 'auto',
      actualTier: 'main-serial',
      selectionReason: 'auto-main-serial',
      engine: { realm: 'host', health: 'running' },
      fault: { code: 'renderer-error', hint: 'inspect the renderer' },
    });
  });

  test('heartbeat schema accepts the projected envelope and not the fat report extras as required fields', () => {
    const projected = toVagExecutionEnvelope(fatReport);
    expect(VagCarrierHeartbeatSchema.safeParse({
      type: 'VAG_CARRIER_HEARTBEAT',
      payload: { ...heartbeatBase, execution: projected },
    }).success).toBe(true);
    expect(VagCarrierHeartbeatSchema.safeParse({
      type: 'VAG_CARRIER_HEARTBEAT',
      payload: { ...heartbeatBase, execution: fatReport },
    }).success).toBe(true);
  });
});
