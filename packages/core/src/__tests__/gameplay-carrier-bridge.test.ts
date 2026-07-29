import { describe, expect, test } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { EditGateway } from '../io/gateway';
import { registerSessionApplier } from '../io/appliers';
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
  test('runs all six operations through a real EditGateway and live projection', async () => {
    const gateway = new EditGateway(createEditSession());
    const inputCalls: unknown[] = [];
    const registry = gateway.createGameProjectionRegistry();
    registry.registrar.registerAction({
      id: 'input', title: 'Input',
      run: (args) => { inputCalls.push(args); },
    });
    registry.registrar.registerRead({ id: 'world', title: 'World', read: () => ({ entities: [1] }) });
    gateway.enterPlay(new World());
    gateway.installGameProjection(registry);
    const unregisterStop = registerSessionApplier('stop', () => {
      gateway.exitPlay();
      return { ok: true };
    });
    const canvas = { toDataURL: () => 'data:image/png;base64,live-frame' } as HTMLCanvasElement;
    let focused = 0;
    const capture = createGameplayCaptureGateway({ canvas, getProvenance: () => identity, focus: () => { focused += 1; } });
    const bridge = createGameplayCarrierBridge(createGameplayOperations(gateway, capture), () => identity);

    await expect(bridge.execute({ version: 1, operation: 'play' })).resolves.toMatchObject({ ok: true, operation: 'play', state: 'running', identity });
    await expect(bridge.execute({ version: 1, operation: 'input', action: { type: 'key', key: 'ArrowRight', phase: 'down' } })).resolves.toMatchObject({ ok: true, operation: 'input', identity });
    await expect(bridge.execute({ version: 1, operation: 'query', query: '' })).resolves.toMatchObject({ ok: true, operation: 'query', data: { entities: [1] }, identity });
    const captureResult = await bridge.execute({ version: 1, operation: 'capture' });
    expect(captureResult).toMatchObject({ ok: true, operation: 'capture', data: { provenance: identity }, identity });
    if (!captureResult.ok || !captureResult.data) throw new Error('capture did not return an artifact');
    await expect(bridge.execute({ version: 1, operation: 'reveal', artifact: captureResult.data as never })).resolves.toMatchObject({ ok: true, operation: 'reveal', identity });
    await expect(bridge.execute({ version: 1, operation: 'gameplayStop' })).resolves.toMatchObject({ ok: true, operation: 'gameplayStop', state: 'stopped', identity });

    expect(inputCalls).toEqual([{ type: 'key', key: 'ArrowRight', phase: 'down' }]);
    expect(focused).toBe(1);
    unregisterStop();
  });

  test('rejects malformed requests and missing live numeric identity before touching the producer', async () => {
    let calls = 0;
    const bridge = createGameplayCarrierBridge({
      play: async () => { calls += 1; return { ok: true, state: 'running' }; },
      gameplayStop: async () => { calls += 1; return { ok: true, state: 'stopped' }; },
      input: async () => { calls += 1; return { ok: true }; },
      query: async () => { calls += 1; return { ok: true, data: null }; },
      capture: async () => { calls += 1; return { ok: true, data: null }; },
      reveal: async () => { calls += 1; return { ok: true }; },
    }, () => null);

    await expect(bridge.execute({ version: 2, operation: 'play' })).resolves.toMatchObject({ ok: false, operation: null, error: { code: 'invalid-request', phase: 'contract' } });
    await expect(bridge.execute({ version: 1, operation: 'play' })).resolves.toMatchObject({ ok: false, operation: 'play', error: { code: 'identity-unavailable', phase: 'identity' } });
    expect(calls).toBe(0);
  });
});
