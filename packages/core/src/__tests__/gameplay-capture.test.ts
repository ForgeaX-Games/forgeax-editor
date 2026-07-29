import { describe, expect, test } from 'bun:test';
import { EditGateway } from '../io/gateway';
import { createGameplayCaptureGateway, createGameplayOperations, type GameplayCaptureArtifact } from '../io/gameplay-operations';

const identity = {
  runtimeId: 'runtime-1',
  scope: { projectId: 'project-1', gameId: 'game-1' },
  pageIdentity: 'page-1',
  canvasIdentity: 'canvas-1',
  rendererGeneration: 7,
} as const;

describe('live gameplay capture', () => {
  test('captures the live canvas with matching provenance and reveals without replacing the page', async () => {
    const canvas = { toDataURL: () => 'data:image/png;base64,live-frame' } as HTMLCanvasElement;
    let focused = 0;
    const gateway = new EditGateway({} as never);
    const captureGateway = createGameplayCaptureGateway({
      canvas,
      getProvenance: () => identity,
      focus: () => { focused += 1; },
    });
    gateway.enterPlay({} as never);
    const operations = createGameplayOperations(gateway, captureGateway);
    const capture = await operations.capture();
    expect(capture.ok).toBe(true);
    expect(capture).toMatchObject({ data: { dataUrl: 'data:image/png;base64,live-frame', bytes: 32, provenance: identity } });
    await expect(operations.reveal((capture as { data: GameplayCaptureArtifact }).data)).resolves.toEqual({ ok: true });
    expect(focused).toBe(1);
  });

  test('fails closed for stale identity without focusing or changing the page', async () => {
    const canvas = { toDataURL: () => 'data:image/png;base64,live-frame' } as HTMLCanvasElement;
    let focused = 0;
    const gateway = new EditGateway({} as never);
    const captureGateway = createGameplayCaptureGateway({ canvas, getProvenance: () => identity, focus: () => { focused += 1; } });
    gateway.enterPlay({} as never);
    const operations = createGameplayOperations(gateway, captureGateway);
    const result = await operations.reveal({ dataUrl: 'data:image/png;base64,old', bytes: 23, provenance: { ...identity, pageIdentity: 'page-old', canvasIdentity: 'canvas-old', rendererGeneration: 6 } });
    expect(result).toMatchObject({ ok: false, error: { code: 'identity-mismatch', details: { dimension: 'pageIdentity' } } });
    expect(focused).toBe(0);
  });

  test('reads the live provenance on every capture and fails closed when generation disappears', async () => {
    const canvas = { toDataURL: () => 'data:image/png;base64,live-frame' } as HTMLCanvasElement;
    let current: typeof identity | null = identity;
    const captureGateway = createGameplayCaptureGateway({ canvas, getProvenance: () => current, focus: () => {} });

    const captured = captureGateway.captureGameplayFrame();
    expect(captured).toMatchObject({ ok: true, value: { provenance: identity } });
    current = null;
    expect(captureGateway.captureGameplayFrame()).toMatchObject({ ok: false, error: { code: 'renderer-generation-unavailable' } });
    expect(captureGateway.revealGameplayFrame((captured as { ok: true; value: GameplayCaptureArtifact }).value))
      .toMatchObject({ ok: false, error: { code: 'renderer-generation-unavailable' } });
  });
});
