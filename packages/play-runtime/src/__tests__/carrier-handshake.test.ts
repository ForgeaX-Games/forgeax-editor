import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  VagCarrierFailureSchema,
  VagCarrierHeartbeatSchema,
} from '@forgeax/editor-core/protocol';

const source = readFileSync(resolve(import.meta.dir, '../main.ts'), 'utf8');

const payload = {
  version: 1 as const,
  runtimeId: 'runtime-a',
  runtimeGeneration: 4,
  carrierId: 'carrier-a:play',
  carrierKind: 'iframe' as const,
  challengeResponse: null,
  scope: null,
  pageNonce: 'page-a',
  pageIdentity: 'http://localhost/preview/',
  canvasIdentity: 'canvas-a',
  rendererIdentity: 'renderer-pending',
  rendererGeneration: null,
  sentinel: 0,
  liveness: 'alive' as const,
  renderReadiness: 'unavailable' as const,
  execution: null,
  failure: {
    code: 'play-carrier-boot-failed',
    stage: 'handshake' as const,
    retryable: true,
    hint: '[engine] requested runtime generation does not match the active binding',
    at: new Date().toISOString(),
    message: '[engine] requested runtime generation does not match the active binding',
  },
};

describe('Play carrier handshake', () => {
  test('keeps runtime and carrier generations in the producer envelope', () => {
    expect(source).toContain('runtimeGeneration: expectedGeneration');
    expect(source).toContain("carrierId: qp.get('carrierId')?.trim() || undefined");
    expect(source).toContain("carrierKind: qp.get('carrierKind') === 'iframe'");
    expect(source).toContain('execution: toVagExecutionEnvelope(carrierExecutionReport)');
    expect(source).toContain("sendVagMessage(window.parent, VagCarrierHeartbeatSchema, carrierPayload(");
    expect(VagCarrierHeartbeatSchema.safeParse({ type: 'VAG_CARRIER_HEARTBEAT', payload: {
      ...payload,
      failure: null,
      renderReadiness: 'ready',
      rendererIdentity: 'renderer-a',
      rendererGeneration: 1,
    } }).success).toBe(true);
  });

  test('publishes the exact boot failure before the binding check can throw', () => {
    const publisher = source.indexOf('function publishCarrierBootFailure');
    const bindingCheck = source.indexOf('let runtimeBinding: RuntimeAssetBinding | undefined;');
    expect(publisher).toBeGreaterThanOrEqual(0);
    expect(bindingCheck).toBeGreaterThan(publisher);
    expect(source).toContain('hint: message');
    expect(source).toContain('message,');
    expect(source).toContain('sendVagMessage(window.parent, VagCarrierFailureSchema, { ...payload, failure: carrierFailure })');
    expect(VagCarrierFailureSchema.safeParse({ type: 'VAG_CARRIER_FAILURE', payload }).success).toBe(true);
  });

  test('reads managed carrier scope through the Projects API', () => {
    expect(source).toContain("fetch('/api/projects/active', { cache: 'no-store' })");
    expect(source).not.toContain('/api/workbench/active-game');
  });
});
