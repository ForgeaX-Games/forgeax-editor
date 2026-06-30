/**
 * useConfirmToast — SSE subscription hook for tool.confirm-required events.
 *
 * Live stream only (D-6): subscribes to GET /api/events/stream?topic=tool.confirm-required.
 * No SSE replay on reconnect — tokens that arrive before connection are ignored.
 *
 * Exposes:
 *   - pendingConfirms: read-only array of pending confirm requests
 *   - ack(token, decision): POST /api/tools/confirm { token, decision: 'allow' }
 *   - deny(token): POST /api/tools/confirm { token, decision: 'deny' }
 */
import { useState, useEffect, useCallback } from 'react';
import { parseSse } from './sse';

export interface ConfirmCaller {
  kind: string;
  threadId?: string;
  [key: string]: unknown;
}

export interface ConfirmPayload {
  toolId: string;
  token: string;
  caller: ConfirmCaller;
  reason?: string;
  message?: string;
}

export interface PendingConfirm extends ConfirmPayload {
  receivedAt: number;
}

/**
 * Parse a raw SSE data string as a tool.confirm-required envelope.
 * Returns the inner ConfirmPayload, or null if the envelope does not match.
 */
export function parseConfirmEnvelope(raw: string): ConfirmPayload | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    (envelope as Record<string, unknown>).topic !== 'tool.confirm-required'
  ) {
    return null;
  }
  const payload = (envelope as Record<string, unknown>).payload;
  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as Record<string, unknown>).toolId !== 'string' ||
    typeof (payload as Record<string, unknown>).token !== 'string' ||
    typeof (payload as Record<string, unknown>).caller !== 'object' ||
    (payload as Record<string, unknown>).caller === null
  ) {
    return null;
  }
  const p = payload as Record<string, unknown>;
  return {
    toolId: p.toolId as string,
    token: p.token as string,
    caller: p.caller as ConfirmCaller,
    reason: typeof p.reason === 'string' ? p.reason : undefined,
    message: typeof p.message === 'string' ? p.message : undefined,
  };
}

const STREAM_URL = '/api/events/stream?topic=tool.confirm-required';
const ACK_URL = '/api/tools/confirm';

export interface UseConfirmToastResult {
  pendingConfirms: PendingConfirm[];
  ack: (token: string) => Promise<void>;
  deny: (token: string) => Promise<void>;
}

export function useConfirmToast(): UseConfirmToastResult {
  const [pendingConfirms, setPendingConfirms] = useState<PendingConfirm[]>([]);

  useEffect(() => {
    let aborted = false;
    const controller = new AbortController();

    const run = async () => {
      let res: Response;
      try {
        res = await fetch(STREAM_URL, { signal: controller.signal });
      } catch {
        return;
      }
      if (!res.ok || !res.body) return;
      try {
        for await (const frame of parseSse(res.body)) {
          if (aborted) break;
          if (!frame.data) continue;
          const payload = parseConfirmEnvelope(frame.data);
          if (!payload) continue;
          setPendingConfirms((prev) => {
            if (prev.some((p) => p.token === payload.token)) return prev;
            return [...prev, { ...payload, receivedAt: Date.now() }];
          });
        }
      } catch {
        // Stream ended or aborted — no-op.
      }
    };

    void run();

    return () => {
      aborted = true;
      controller.abort();
    };
  }, []);

  const dismiss = useCallback((token: string) => {
    setPendingConfirms((prev) => prev.filter((p) => p.token !== token));
  }, []);

  const ack = useCallback(
    async (token: string) => {
      try {
        await fetch(ACK_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token, decision: 'allow' }),
        });
      } finally {
        dismiss(token);
      }
    },
    [dismiss],
  );

  const deny = useCallback(
    async (token: string) => {
      try {
        await fetch(ACK_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token, decision: 'deny' }),
        });
      } finally {
        dismiss(token);
      }
    },
    [dismiss],
  );

  return { pendingConfirms, ack, deny };
}
