import { describe, expect, it } from 'bun:test';
import {
  applyToolClientRunEvent,
  createToolClientProjection,
  type ToolClientRunEvent,
} from '../tool-client-events';

const accepted: ToolClientRunEvent = {
  type: 'accepted', runId: 'run-1', requestId: 'request-1', operationId: 'texture.preview',
  actor: { id: 'ai-1', kind: 'ai' }, sessionId: 'ai-session', scope: 'private',
  traceId: 'trace-1', sequence: 1, at: 1,
};

describe('host ToolClient run event projection', () => {
  it('reconnects from host POD events without owning a Gateway executor', () => {
    const source = createToolClientProjection();
    expect(source.authority).toBe('host-toolclient-observer');
    expect(applyToolClientRunEvent(source, accepted).ok).toBe(true);
    expect(applyToolClientRunEvent(source, { type: 'running', runId: 'run-1', sequence: 2, at: 2 }).ok).toBe(true);
    expect(applyToolClientRunEvent(source, {
      type: 'progress', runId: 'run-1', sequence: 3, at: 3,
      progress: { fraction: 0.5, stage: 'render' },
    }).ok).toBe(true);
    const terminal = applyToolClientRunEvent(source, {
      type: 'succeeded', runId: 'run-1', sequence: 4, at: 4,
      result: { subject: { kind: 'TextureAsset', guid: 'tex-1' }, snapshot: { revision: 2, digest: 'sha256:2' } },
    });
    expect(terminal).toMatchObject({ ok: true, value: { runId: 'run-1', status: 'succeeded', sequence: 4 } });
    expect(source.getSnapshot().runs[0]).toMatchObject({ requestId: 'request-1', traceId: 'trace-1' });
    expect(source.reconnect().runs[0]).toMatchObject({ runId: 'run-1', status: 'succeeded', sequence: 4 });
  });

  it('keeps private run identity after observer disconnect and does not expose authority methods', () => {
    const source = createToolClientProjection();
    expect(source).not.toHaveProperty('cancel');
    expect(source).not.toHaveProperty('retry');
    expect(source).not.toHaveProperty('dispatch');
    source.disconnect();
    expect(source.reconnect()).toEqual({ revision: 0, runs: [] });
  });
});
