import { describe, expect, it } from 'bun:test';
import {
  assertPreviewSessionIsolation,
  createInteractivePreviewSession,
} from '../interactive-session-isolation';

describe('interactive preview session isolation', () => {
  it('creates a bounded human session without ToolRun live state', () => {
    const session = createInteractivePreviewSession({
      domain: 'mesh',
      subjectGuid: 'mesh-1',
      sessionId: 'human:mesh:1',
    });

    expect(session).toMatchObject({
      domain: 'mesh',
      subjectGuid: 'mesh-1',
      sessionId: 'human:mesh:1',
      source: 'editor-interactive',
    });
    expect(session).not.toHaveProperty('toolRunId');
    expect(session).not.toHaveProperty('world');
    expect(session).not.toHaveProperty('renderer');
    expect(session).not.toHaveProperty('canvas');
  });

  it('rejects shared world, renderer, canvas, or session identities', () => {
    const canonical = {
      source: 'engine-tool-run',
      sessionId: 'run:mesh:1',
      worldId: 'world:canonical',
      rendererId: 'renderer:canonical',
      canvasId: 'canvas:canonical',
    } as const;
    const interactive = createInteractivePreviewSession({
      domain: 'mesh',
      subjectGuid: 'mesh-1',
      sessionId: 'human:mesh:1',
      worldId: 'world:interactive',
      rendererId: 'renderer:interactive',
      canvasId: 'canvas:interactive',
    });

    expect(assertPreviewSessionIsolation(canonical, interactive)).toEqual({ ok: true });
    expect(assertPreviewSessionIsolation(
      canonical,
      createInteractivePreviewSession({
        domain: 'mesh',
        subjectGuid: 'mesh-1',
        sessionId: 'run:mesh:1',
        worldId: 'world:canonical',
        rendererId: 'renderer:interactive',
        canvasId: 'canvas:interactive',
      }),
    )).toMatchObject({ ok: false, code: 'preview-session-shared-live-state' });
  });
});
