import { describe, expect, it } from 'bun:test';
import {
  VagCarrierFailureSchema,
  VagCarrierHandshakeSchema,
  VagCarrierHeartbeatSchema,
} from './protocol';

const basePayload = {
  version: 1 as const,
  runtimeId: 'runtime-a',
  challengeResponse: null,
  scope: { projectId: 'project-a', gameId: 'game-a' },
  pageNonce: 'page-nonce-a',
  pageIdentity: 'http://localhost:18920/editor',
  canvasIdentity: 'canvas-a',
  rendererGeneration: 4,
  rendererIdentity: 'renderer-a',
  sentinel: 12,
  liveness: 'alive' as const,
  renderReadiness: 'ready' as const,
  failure: null,
};

describe('carrier VAG protocol', () => {
  it('accepts a versioned confirmed handshake with surface identity and health', () => {
    const result = VagCarrierHandshakeSchema.safeParse({
      type: 'VAG_CARRIER_HANDSHAKE',
      payload: basePayload,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.payload.scope).toEqual({ projectId: 'project-a', gameId: 'game-a' });
      expect(result.data.payload.pageNonce).toBe('page-nonce-a');
      expect(result.data.payload.canvasIdentity).toBe('canvas-a');
      expect(result.data.payload.rendererGeneration).toBe(4);
      expect(result.data.payload.rendererIdentity).toBe('renderer-a');
      expect(result.data.payload.renderReadiness).toBe('ready');
    }
  });

  it('accepts an unconfirmed scope without inventing an identity', () => {
    const result = VagCarrierHandshakeSchema.safeParse({
      type: 'VAG_CARRIER_HANDSHAKE',
      payload: { ...basePayload, scope: null, renderReadiness: 'pending' },
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.payload.scope).toBeNull();
  });

  it('requires protocol version one and monotonic heartbeat sentinel shape', () => {
    expect(VagCarrierHandshakeSchema.safeParse({
      type: 'VAG_CARRIER_HANDSHAKE',
      payload: { ...basePayload, version: 2 },
    }).success).toBe(false);

    const first = VagCarrierHeartbeatSchema.safeParse({
      type: 'VAG_CARRIER_HEARTBEAT',
      payload: { ...basePayload, sentinel: 13 },
    });
    const second = VagCarrierHeartbeatSchema.safeParse({
      type: 'VAG_CARRIER_HEARTBEAT',
      payload: { ...basePayload, sentinel: 14 },
    });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (first.success && second.success) {
      expect(second.data.payload.sentinel).toBeGreaterThan(first.data.payload.sentinel);
    }
  });

  it('carries structured renderer failure without replacing the legacy device-lost type', () => {
    const result = VagCarrierFailureSchema.safeParse({
      type: 'VAG_CARRIER_FAILURE',
      payload: {
        ...basePayload,
        renderReadiness: 'unavailable',
        failure: {
          code: 'device-lost',
          stage: 'device-lost',
          retryable: false,
          hint: 'Stop the runtime and ensure it again.',
          at: '2026-07-27T00:00:00.000Z',
          message: 'The WebGPU device was lost.',
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.payload.failure?.code).toBe('device-lost');
      expect(result.data.payload.failure?.hint).toContain('ensure');
      expect(result.data.payload.renderReadiness).toBe('unavailable');
    }
  });

  it('fails closed when the numeric renderer generation is absent', () => {
    expect(VagCarrierHandshakeSchema.safeParse({
      type: 'VAG_CARRIER_HANDSHAKE',
      payload: { ...basePayload, rendererGeneration: undefined },
    }).success).toBe(false);

    const unavailable = VagCarrierHandshakeSchema.safeParse({
      type: 'VAG_CARRIER_HANDSHAKE',
      payload: {
        ...basePayload,
        rendererGeneration: null,
        renderReadiness: 'unavailable',
        failure: {
          code: 'renderer-generation-unavailable',
          stage: 'renderer',
          retryable: true,
          hint: 'wait for a numeric renderer generation',
          at: '2026-07-29T00:00:00.000Z',
        },
      },
    });
    expect(unavailable.success).toBe(true);
  });
});
