import { describe, expect, test } from 'bun:test';
import { EditGateway } from '../io/gateway';
import { createGameplayCaptureGateway, createGameplayOperations } from '../io/gameplay-operations';

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
    const canvas = { toDataURL: () => png } as HTMLCanvasElement;
    const gateway = new EditGateway({} as never);
    const captureGateway = createGameplayCaptureGateway({
      canvas,
      getProvenance: () => identity,
    });
    gateway.enterPlay({} as never);
    const operations = createGameplayOperations(gateway, captureGateway);
    const capture = await operations.capture();
    expect(capture.ok).toBe(true);
    expect(capture).toMatchObject({ data: { dataUrl: png, bytes: 68, provenance: identity } });
  });

  test('reads the live provenance on every capture and fails closed when generation disappears', async () => {
    const canvas = { toDataURL: () => png } as HTMLCanvasElement;
    let current: typeof identity | null = identity;
    const captureGateway = createGameplayCaptureGateway({ canvas, getProvenance: () => current });

    const captured = await captureGateway.captureGameplayFrame();
    expect(captured).toMatchObject({ ok: true, value: { provenance: identity } });
    current = null;
    await expect(captureGateway.captureGameplayFrame()).resolves.toMatchObject({ ok: false, error: { code: 'renderer-generation-unavailable' } });
  });

  test('rejects malformed image data from the producer', async () => {
    const canvas = { toDataURL: () => 'data:image/png;base64,not-base64!' } as HTMLCanvasElement;
    await expect(createGameplayCaptureGateway({ canvas, getProvenance: () => identity }).captureGameplayFrame())
      .resolves.toMatchObject({ ok: false, error: { code: 'surface-unavailable' } });
  });
});
