import type { CommandOrigin, DispatchResult, PlayDirtyPolicy } from '@forgeax/editor-core';
import type { PlayDispatchResult } from './play-operation';

interface PlayTarget {
  prepareScene(policy: PlayDirtyPolicy, origin: CommandOrigin): Promise<void>;
  play(policy: PlayDirtyPolicy, origin: CommandOrigin, requestId?: string): PlayDispatchResult;
  stop(): void;
  isPlaying(): boolean;
  preparing?(): void;
  failed?(error: unknown): void;
}

const cancelled = () => ({ code: 'play-cancelled' as const, hint: 'Play preparation was cancelled.' });
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Owned by the game host, outside a replaceable viewport realm. */
export function createPlayPreparation(prepareRuntime: (signal: AbortSignal, requestId?: string) => Promise<void>) {
  let target: PlayTarget | undefined;
  let disposed = false;
  let preparation: { controller: AbortController; result: Promise<PlayTarget>; policy: PlayDirtyPolicy } | undefined;
  let pending: PlayDispatchResult | undefined;
  let stopPending: (() => void) | undefined;
  // A server request is prepared before it enters the replaceable transport.
  // Its one-use ticket prevents a second reconciliation inside that transport.
  const tickets = new Map<string, PlayTarget | undefined>();
  const invalidateTickets = () => { for (const key of tickets.keys()) tickets.set(key, undefined); };

  async function prepare(policy: PlayDirtyPolicy, origin: CommandOrigin, requestId?: string): Promise<PlayTarget> {
    if (disposed) throw cancelled();
    if (preparation) {
      if (preparation.policy !== policy) throw { code: 'play-preparation-in-progress', hint: 'Another Play preparation uses a different save policy.' };
      return preparation.result;
    }
    const initial = target;
    if (!initial) throw { code: 'play-unavailable', hint: 'The viewport is not ready.' };
    if (initial.isPlaying()) return initial;
    const controller = new AbortController();
    const result = abortable((async () => {
      await initial.prepareScene(policy, origin);
      if (controller.signal.aborted) throw cancelled();
      initial.preparing?.();
      await prepareRuntime(controller.signal, requestId);
      if (controller.signal.aborted || disposed) throw cancelled();
      if (!target) throw { code: 'play-unavailable', hint: 'The prepared viewport is not ready.' };
      return target;
    })(), controller.signal);
    const entry = { controller, result, policy };
    preparation = entry;
    void result.catch((error) => { if (!disposed && preparation === entry && !controller.signal.aborted) target?.failed?.(error); })
      .finally(() => { if (preparation === entry) preparation = undefined; });
    return result;
  }

  const api = {
    attach(next: PlayTarget): () => void {
      if (disposed) return () => {};
      target = next;
      if (preparation && !preparation.controller.signal.aborted) next.preparing?.();
      return () => {
        if (target !== next) return;
        target = undefined;
        invalidateTickets();
        // Intentional same-game preparation may rebuild the realm. Any other
        // teardown must stop the active operation rather than resume it later.
        if (!preparation) stopPending?.();
      };
    },
    async prepareRequest(requestId: string, policy: PlayDirtyPolicy, signal: AbortSignal): Promise<void> {
      if (signal.aborted) throw cancelled();
      const next = await abortable(prepare(policy, 'ai'), signal);
      if (disposed || signal.aborted || next !== target) throw cancelled();
      tickets.set(requestId, next);
    },
    releaseRequest(requestId: string): void { tickets.delete(requestId); },
    play(policy: PlayDirtyPolicy = 'last-saved', origin: CommandOrigin = 'human', requestId?: string): PlayDispatchResult {
      if (pending) return pending;
      if (disposed) return { ok: false, error: cancelled() };
      const controller = new AbortController();
      let started: PlayDispatchResult | undefined;
      const stop = () => {
        controller.abort();
        preparation?.controller.abort();
        invalidateTickets();
        started?.cancel?.();
        target?.stop();
      };
      const work = (async (): Promise<DispatchResult> => {
        const reserved = requestId !== undefined && tickets.has(requestId);
        const ticket = requestId ? tickets.get(requestId) : undefined;
        if (requestId) tickets.delete(requestId);
        if (reserved && (!ticket || ticket !== target)) throw cancelled();
        const next = reserved ? ticket! : await prepare(policy, origin, requestId);
        if (controller.signal.aborted || disposed || next !== target) throw cancelled();
        started = next.play(policy, origin, requestId);
        return await (started.completion ?? started);
      })();
      const completion: Promise<DispatchResult> = abortable(work, controller.signal).catch((error) => ({
        ok: false, error: error && typeof error.code === 'string'
          ? error : { code: 'play-preparation-failed', hint: String(error) },
      }));
      const result: PlayDispatchResult = { ok: true, completion, cancel: stop };
      pending = result;
      stopPending = stop;
      void completion.finally(() => { if (pending === result) { pending = undefined; stopPending = undefined; } });
      return result;
    },
    stop(): void {
      preparation?.controller.abort();
      if (stopPending) stopPending(); else target?.stop();
      invalidateTickets();
    },
    dispose(): void { disposed = true; api.stop(); target = undefined; },
  };
  return api;
}

export type PlayPreparation = ReturnType<typeof createPlayPreparation>;
