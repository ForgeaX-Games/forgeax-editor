/**
 * w13 — SSE parser integration test for useConfirmToast (red phase).
 *
 * Verifies that the hook's SSE parsing logic correctly decodes a
 * tool.confirm-required envelope pushed over a ReadableStream into
 * a { toolId, token, caller } payload.
 *
 * The hook (useConfirmToast.ts) does not exist yet — this test is
 * intentionally red until w14 provides the implementation.
 */
import { describe, it, expect } from 'bun:test';
import { parseConfirmEnvelope, type ConfirmPayload } from './useConfirmToast';
import { parseSse } from './sse';

// Helper: build a ReadableStream<Uint8Array> from a string of SSE text.
function makeStream(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(bytes);
      ctrl.close();
    },
  });
}

// Helper: collect all frames from parseSse.
async function collectFrames(stream: ReadableStream<Uint8Array>) {
  const frames: Array<{ event: string; data: string }> = [];
  for await (const f of parseSse(stream)) {
    frames.push(f);
  }
  return frames;
}

describe('parseConfirmEnvelope', () => {
  it('decodes tool.confirm-required envelope into { toolId, token, caller }', () => {
    const rawPayload = {
      topic: 'tool.confirm-required',
      payload: {
        toolId: 'my-tool',
        token: 'confirm-my-tool-1748000000000-abc123',
        caller: { kind: 'ai' },
      },
    };
    const result = parseConfirmEnvelope(JSON.stringify(rawPayload));
    expect(result).not.toBeNull();
    const p = result as ConfirmPayload;
    expect(p.toolId).toBe('my-tool');
    expect(p.token).toBe('confirm-my-tool-1748000000000-abc123');
    expect(p.caller).toEqual({ kind: 'ai' });
  });

  it('returns null for non-confirm-required topic', () => {
    const rawPayload = {
      topic: 'tool.starting',
      payload: { toolId: 'my-tool', token: 't1', caller: { kind: 'ai' } },
    };
    const result = parseConfirmEnvelope(JSON.stringify(rawPayload));
    expect(result).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseConfirmEnvelope('not-json')).toBeNull();
  });

  it('decodes message field from payload', () => {
    const rawPayload = {
      topic: 'tool.confirm-required',
      payload: {
        toolId: 'gen3d:auto-rig',
        token: 'confirm-gen3d-auto-rig-1748000003000-xyz789',
        caller: { kind: 'ai' },
        message: 'Auto-rig will consume about 5 Meshy credits. Continue?',
      },
    };
    const result = parseConfirmEnvelope(JSON.stringify(rawPayload));
    expect(result).not.toBeNull();
    const p = result as ConfirmPayload;
    expect(p.message).toBe('Auto-rig will consume about 5 Meshy credits. Continue?');
    expect(p.reason).toBeUndefined();
  });
});

describe('parseSse + parseConfirmEnvelope (integration)', () => {
  it('extracts confirm payload from a live SSE stream frame', async () => {
    const envelope = {
      topic: 'tool.confirm-required',
      payload: {
        toolId: 'delete-file',
        token: 'confirm-delete-file-1748000001000-zx9y7w',
        caller: { kind: 'ai', threadId: 'thread-abc' },
      },
    };
    const sseText =
      `event: message\ndata: ${JSON.stringify(envelope)}\n\n`;

    const frames = await collectFrames(makeStream(sseText));
    expect(frames).toHaveLength(1);

    const payloads = frames
      .map((f) => parseConfirmEnvelope(f.data))
      .filter(Boolean) as ConfirmPayload[];

    expect(payloads).toHaveLength(1);
    expect(payloads[0].toolId).toBe('delete-file');
    expect(payloads[0].token).toBe('confirm-delete-file-1748000001000-zx9y7w');
    expect(payloads[0].caller).toMatchObject({ kind: 'ai' });
  });

  it('ignores non-confirm-required frames in a mixed SSE stream', async () => {
    const confirmEnvelope = {
      topic: 'tool.confirm-required',
      payload: {
        toolId: 'risky-op',
        token: 'confirm-risky-op-1748000002000-p3q4r5',
        caller: { kind: 'ai' },
      },
    };
    const otherEnvelope = {
      topic: 'tool.starting',
      payload: { toolId: 'safe-op' },
    };
    const sseText =
      `event: message\ndata: ${JSON.stringify(otherEnvelope)}\n\n` +
      `event: message\ndata: ${JSON.stringify(confirmEnvelope)}\n\n`;

    const frames = await collectFrames(makeStream(sseText));
    expect(frames).toHaveLength(2);

    const payloads = frames
      .map((f) => parseConfirmEnvelope(f.data))
      .filter(Boolean) as ConfirmPayload[];

    expect(payloads).toHaveLength(1);
    expect(payloads[0].toolId).toBe('risky-op');
  });
});
