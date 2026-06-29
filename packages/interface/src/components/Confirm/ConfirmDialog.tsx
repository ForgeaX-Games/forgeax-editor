/**
 * Doc 07 §9.5 — front half of `requireConfirm`.
 *
 * Backend already emits `tool.confirm-required` envelopes when an AI- or
 * skill-driven `callTool` hits a tool flagged `requireConfirm`. The host UI
 * reads them off the SSE stream and renders a modal with Allow / Deny.
 * The user's verdict goes back to `/api/tools/confirm`, which feeds
 * `tool.confirm-resolved` into the registry's awaiter.
 *
 * The modal is intentionally minimal: timer (`expiresAt`), tool id, args
 * preview, caller kind. No theming yet — the frequent path is "user
 * accepts" so the heaviest cost is the network roundtrip, not the dialog.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useTranslation } from '@/i18n';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';

interface ConfirmRequiredEnv {
  topic: 'tool.confirm-required';
  payload: {
    confirmId: string;
    toolId: string;
    args?: unknown;
    caller?: { kind?: string };
    message?: string | null;
    expiresAt?: number;
  };
}

interface ConfirmResolvedEnv {
  topic: 'tool.confirm-resolved';
  payload: { confirmId: string };
}

type AnyConfirmEnv = ConfirmRequiredEnv | ConfirmResolvedEnv;

interface PendingConfirm {
  confirmId: string;
  toolId: string;
  args?: unknown;
  callerKind?: string;
  message?: string | null;
  expiresAt?: number;
}

export function ConfirmDialog(): ReactElement | null {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<PendingConfirm[]>([]);
  const queueRef = useRef<PendingConfirm[]>([]);
  queueRef.current = queue;
  // Tracks confirmIds already given an explicit verdict, so the AlertDialog's
  // auto onOpenChange(false) (fired by Action/Cancel) does not double-send a
  // dismiss deny after a real allow/deny. Keeps the verdict exactly-once.
  const resolvedRef = useRef<Set<string>>(new Set());

  const [now, setNow] = useState<number>(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource('/api/events/stream?topic=tool.confirm-*');
    } catch {
      return;
    }
    es.addEventListener('event', (ev: MessageEvent) => {
      let env: AnyConfirmEnv | null = null;
      try { env = JSON.parse(ev.data) as AnyConfirmEnv; } catch { return; }
      if (!env) return;
      if (env.topic === 'tool.confirm-required') {
        const p = env.payload;
        if (!p?.confirmId) return;
        // De-dup: if the confirmId already in queue, skip.
        if (queueRef.current.some((q) => q.confirmId === p.confirmId)) return;
        setQueue((prev) => [
          ...prev,
          {
            confirmId: p.confirmId,
            toolId: p.toolId,
            args: p.args,
            callerKind: p.caller?.kind,
            message: p.message,
            expiresAt: p.expiresAt,
          },
        ]);
      } else if (env.topic === 'tool.confirm-resolved') {
        // Some other UI / CLI resolved it; drop from queue.
        const id = env.payload?.confirmId;
        if (!id) return;
        setQueue((prev) => prev.filter((q) => q.confirmId !== id));
      }
    });
    return () => { if (es) es.close(); };
  }, []);

  const head = queue[0];
  if (!head) return null;

  const send = async (decision: 'allow' | 'deny', reason?: string) => {
    resolvedRef.current.add(head.confirmId);
    try {
      await fetch('/api/tools/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmId: head.confirmId, decision, reason }),
      });
    } catch { /* server will time out the awaiter on its own */ }
    setQueue((prev) => prev.filter((q) => q.confirmId !== head.confirmId));
  };

  const remainingMs = head.expiresAt ? Math.max(0, head.expiresAt - now) : null;
  const remainingS = remainingMs == null ? null : Math.ceil(remainingMs / 1000);

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        // Esc / overlay close == dismiss == deny. Skip if a button already
        // resolved this confirmId (Action/Cancel also fire onOpenChange).
        if (!open && !resolvedRef.current.has(head.confirmId)) {
          void send('deny', 'dismissed');
        }
      }}
    >
      <AlertDialogContent className="max-w-xl">
        <AlertDialogHeader>
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{t('confirmDialog.wantsToRunTool', { caller: head.callerKind ?? 'AI' })}</span>
            {remainingS != null && (
              <span className={remainingS < 5 ? 'text-destructive' : 'text-muted-foreground'}>
                {remainingS}s
              </span>
            )}
          </div>
          <AlertDialogTitle className="font-mono text-base">
            {head.toolId}
          </AlertDialogTitle>
          {head.message && (
            <AlertDialogDescription>{head.message}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <pre className="my-1 max-h-52 overflow-auto rounded bg-muted p-2.5 text-xs text-info">
          {safeStringify(head.args)}
        </pre>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => send('deny')}>{t('confirmDialog.deny')}</AlertDialogCancel>
          <AlertDialogAction autoFocus onClick={() => send('allow')}>
            {t('confirmDialog.allow')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function safeStringify(v: unknown): string {
  if (v === undefined) return '(no args)';
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}
