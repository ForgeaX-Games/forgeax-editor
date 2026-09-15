import { describe, expect, test } from 'bun:test';
import { EditGateway } from '../io/gateway';
import { createGameplayCaptureGateway, createGameplayOperations, createGameplayCarrierBridge } from '../io/gameplay-operations';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const identity = {
  runtimeId: 'runtime-1',
  scope: { projectId: 'project-1', gameId: 'game-1' },
  pageIdentity: 'page-1',
  canvasIdentity: 'canvas-1',
  rendererGeneration: 7,
} as const;

describe('live gameplay capture', () => {
  test('captures the live canvas with matching provenance and decoded byte count', async () => {
    const gateway = new EditGateway({} as never);
    const captureGateway = createGameplayCaptureGateway({
      captureImage: async () => png,
      getProvenance: () => identity,
    });
    gateway.enterPlay({} as never);
    const operations = createGameplayOperations(gateway, captureGateway);
    const capture = await operations.capture();
    expect(capture.ok).toBe(true);
    expect(capture).toMatchObject({ data: { dataUrl: png, bytes: 68, provenance: identity } });
  });

  test('reads the live provenance on every capture and fails closed when generation disappears', async () => {
    let current: typeof identity | null = identity;
    const captureGateway = createGameplayCaptureGateway({ captureImage: async () => png, getProvenance: () => current });

    const captured = await captureGateway.captureGameplayFrame();
    expect(captured).toMatchObject({ ok: true, value: { provenance: identity } });
    current = null;
    await expect(captureGateway.captureGameplayFrame()).resolves.toMatchObject({ ok: false, error: { code: 'renderer-generation-unavailable' } });
  });

  test('rejects malformed image data from the producer', async () => {
    await expect(createGameplayCaptureGateway({
      captureImage: async () => 'data:image/png;base64,not-base64!',
      getProvenance: () => identity,
    }).captureGameplayFrame())
      .resolves.toMatchObject({ ok: false, error: { code: 'surface-unavailable' } });
  });

  test('fails explicitly when the composed viewport producer rejects', async () => {
    await expect(createGameplayCaptureGateway({
      captureImage: async () => { throw new Error('viewport HUD root is unavailable'); },
      getProvenance: () => identity,
    }).captureGameplayFrame()).resolves.toMatchObject({
      ok: false,
      error: { code: 'capture-failed', hint: 'viewport HUD root is unavailable' },
    });
  });
});


test('capture diagnostic stage and observed identity reach the public carrier error', async () => {
  const gateway = new EditGateway({} as never); gateway.enterPlay({} as never);
  const capture = createGameplayCaptureGateway({ getProvenance: () => identity,
    captureImage: async () => { throw Object.assign(new Error('viewport capture timed out'), {
      details: { stage: 'hud-rasterization', elapsedMs: 5001, timeoutMs: 5000 },
    }); },
  });
  const bridge = createGameplayCarrierBridge(createGameplayOperations(gateway, capture), () => identity);
  await expect(bridge.execute({ version: 1, operation: 'capture' })).resolves.toMatchObject({ ok: false,
    error: { code: 'capture-failed', phase: 'capture', details: {
      stage: 'hud-rasterization', elapsedMs: 5001, timeoutMs: 5000, provenance: identity, currentProvenance: identity,
    } },
  });
});

test('identity replacement during capture rejects a successful old PNG', async () => {
  let current: { readonly runtimeId: string } & Omit<typeof identity, 'runtimeId'> = identity;
  const capture = createGameplayCaptureGateway({ getProvenance: () => current,
    captureImage: async () => { current = { ...identity, runtimeId: 'replacement' }; return png; },
  });
  await expect(capture.captureGameplayFrame()).resolves.toMatchObject({ ok: false, error: { code: 'identity-mismatch' } });
});

test('Stop during capture cannot publish a successful artifact', async () => {
  let phase = 'play';
  const capture = createGameplayCaptureGateway({ getProvenance: () => identity,
    captureImage: async () => { phase = 'edit'; return png; },
  });
  const gateway = { get playPhase() { return phase; } } as never;
  await expect(createGameplayOperations(gateway, capture).capture()).resolves.toMatchObject({ ok: false });
});
