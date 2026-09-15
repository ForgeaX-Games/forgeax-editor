import { describe, expect, test } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { EditGateway } from '../io/gateway';
import { createGameplayCaptureGateway, createGameplayCarrierBridge, createGameplayOperations } from '../io/gameplay-operations';
import { createEditSession } from '../session/document';

const identity = {
  runtimeId: 'runtime-1',
  scope: { projectId: 'project-1', gameId: 'game-1' },
  pageIdentity: 'page-1',
  canvasIdentity: 'canvas-1',
  rendererGeneration: 8,
} as const;

describe('live gameplay carrier bridge', () => {
  test('runs input, query, and capture through a real EditGateway and live projection', async () => {
    const gateway = new EditGateway(createEditSession());
    const inputCalls: unknown[] = [];
    const registry = gateway.createGameProjectionRegistry();
    registry.registrar.registerRead({ id: 'world', title: 'World', read: () => ({ entities: [1] }) });
    gateway.enterPlay(new World());
    gateway.installGameProjection(registry);
    const capture = createGameplayCaptureGateway({
      captureImage: async () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      getProvenance: () => identity,
    });
    const bridge = createGameplayCarrierBridge(createGameplayOperations(gateway, capture, async (action) => { inputCalls.push(action); return { ok: true, data: { acknowledged: inputCalls.length } }; }), () => identity);

    await expect(bridge.execute({ version: 1, operation: 'describe' })).resolves.toMatchObject({
      ok: true,
      operation: 'describe',
      data: {
        projections: {
          runtime: { playPhase: 'play', captureAvailable: true },
          actions: [],
          reads: [{ id: 'world', title: 'World' }],
        },
      },
    });
    await expect(bridge.execute({ version: 1, operation: 'input', action: { type: 'key', key: 'ArrowRight', phase: 'down' } })).resolves.toMatchObject({ ok: true, operation: 'input', data: { acknowledged: 1 }, identity });
    await expect(bridge.execute({ version: 1, operation: 'input', action: {
      type: 'pointer', phase: 'down', pointerId: 7, pointerType: 'touch', x: 120, y: 80,
    } })).resolves.toMatchObject({ ok: true, operation: 'input', data: { acknowledged: 2 }, identity });
    await expect(bridge.execute({ version: 1, operation: 'query', query: '' })).resolves.toMatchObject({ ok: true, operation: 'query', data: { entities: [1] }, identity });
    const captureResult = await bridge.execute({ version: 1, operation: 'capture' });
    expect(captureResult).toMatchObject({ ok: true, operation: 'capture', data: { provenance: identity }, identity });
    expect(inputCalls).toEqual([
      { type: 'key', key: 'ArrowRight', phase: 'down' },
      { type: 'pointer', phase: 'down', pointerId: 7, pointerType: 'touch', x: 120, y: 80 },
    ]);
  });

  test('rejects malformed requests and missing live numeric identity before touching the producer', async () => {
    let calls = 0;
    const bridge = createGameplayCarrierBridge({
      describe: () => ({ actions: [], reads: [] }),
      input: async () => { calls += 1; return { ok: true }; },
      query: async () => { calls += 1; return { ok: true, data: null }; },
      capture: async () => { calls += 1; return { ok: true, data: null }; },
    }, () => null);

    const description = await bridge.execute({ version: 1, operation: 'describe' });
    expect(description).toMatchObject({
      ok: true,
      operation: 'describe',
      data: { projections: { actions: [], reads: [] } },
    });
    expect(Array.isArray(description.ok && description.data
      ? (description.data as { operations?: unknown }).operations
      : undefined)).toBe(true);
    for (const operation of ['play', 'gameplayStop', 'reveal']) {
      await expect(bridge.execute({ version: 1, operation })).resolves.toMatchObject({ ok: false, operation: null, error: { code: 'invalid-request', phase: 'contract' } });
    }
    await expect(bridge.execute({ version: 1, operation: 'input', action: {
      type: 'pointer', phase: 'drag', x: 0, y: 0,
    } })).resolves.toMatchObject({ ok: false, operation: null, error: { code: 'invalid-request', phase: 'contract' } });
    await expect(bridge.execute({ version: 1, operation: 'capture' })).resolves.toMatchObject({ ok: false, operation: 'capture', error: { code: 'identity-unavailable', phase: 'identity' } });
    expect(calls).toBe(0);
  });
});

test('discovery and capture failure expose the current Play prerequisite without starting it', async () => {
  const gateway = new EditGateway(createEditSession());
  let captures = 0;
  const capture = { captureGameplayFrame: async () => { captures++; throw new Error('must not capture while inactive'); } };
  const bridge = createGameplayCarrierBridge(createGameplayOperations(gateway, capture), () => identity);
  for (const phase of ['edit', 'starting', 'failed'] as const) {
    if (phase === 'starting') gateway.beginPlayAttempt();
    if (phase === 'failed') gateway.failPlayAttempt({ code: 'test-failure', hint: 'test failure' } as never);
    expect(await bridge.execute({ version: 1, operation: 'describe' })).toMatchObject({
      ok: true, data: { projections: { runtime: { playPhase: phase, captureAvailable: false } } },
    });
    expect(await bridge.execute({ version: 1, operation: 'capture' })).toMatchObject({
      ok: false, error: { code: 'surface-unavailable', details: { playPhase: phase, statusQuery: { kind: 'viewport.status' } } },
    });
    expect(gateway.playPhase).toBe(phase);
  }
  expect(captures).toBe(0);
});
