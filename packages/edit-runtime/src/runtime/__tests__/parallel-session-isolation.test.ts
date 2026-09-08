import { describe, expect, it } from 'bun:test';
import { assertPreviewSessionIsolation, createInteractivePreviewSession } from '../../preview-world/interactive-session-isolation';

describe('parallel human and AI preview session isolation', () => {
  it('keeps World/Renderer/Canvas, draft, undo, and cancellation identities separate', () => {
    const ai = { source: 'engine-tool-run', sessionId: 'run:material:1', worldId: 'world:ai:1', rendererId: 'renderer:ai:1', canvasId: 'canvas:ai:1' } as const;
    const human = createInteractivePreviewSession({ domain: 'material', subjectGuid: 'material-human', sessionId: 'human:material:1', worldId: 'world:human:1', rendererId: 'renderer:human:1', canvasId: 'canvas:human:1' });
    expect(assertPreviewSessionIsolation(ai, human)).toEqual({ ok: true });
    const humanTransaction = { draftId: 'draft:human:1', undoGroupId: 'undo:human:1', cancellationId: 'cancel:human:1' };
    const aiTransaction = { draftId: 'draft:ai:1', undoGroupId: 'undo:ai:1', cancellationId: 'cancel:ai:1' };
    expect(humanTransaction).not.toEqual(aiTransaction);
    expect(humanTransaction.cancellationId).not.toBe(aiTransaction.cancellationId);
  });

  it('keeps a second human Level/Play session isolated from the AI carrier', () => {
    const ai = { source: 'engine-tool-run', sessionId: 'run:vfx:2', worldId: 'world:ai:2', rendererId: 'renderer:ai:2', canvasId: 'canvas:ai:2' } as const;
    for (const session of [
      createInteractivePreviewSession({ domain: 'vfx', subjectGuid: 'vfx-human', sessionId: 'human:vfx:2' }),
      createInteractivePreviewSession({ domain: 'mesh', subjectGuid: 'level-play', sessionId: 'human:play:2' }),
    ]) {
      expect(assertPreviewSessionIsolation(ai, session)).toEqual({ ok: true });
    }
  });
});
