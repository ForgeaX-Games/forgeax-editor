import type { CommandOrigin, DispatchResult, PlayDirtyPolicy } from '@forgeax/editor-core';
import type { HostGateway } from './host-session';
import type { RunLifecycle } from './run-lifecycle';

export type PlayDispatchResult = DispatchResult & { readonly completion?: Promise<DispatchResult>; readonly cancel?: () => void };

/** The Gateway owns run records; this host adapter owns the pending Play effect. */
export function createPlayOperation(deps: {
  gateway: Pick<HostGateway, 'playPhase' | 'lastPlayError' | 'dispatch' | 'waitOperationRun' | 'beginPlayAttempt' | 'failPlayAttempt'>;
  lifecycle: () => RunLifecycle | null;
  hasPendingDiskSave: () => boolean;
  invalidateScene: (value: boolean) => void;
  onFailure: (error: unknown) => void;
}) {
  let pending: { completion: Promise<DispatchResult>; cancel: () => void; stop: () => void } | undefined;
  const cancelled: DispatchResult = { ok: false, error: { code: 'play-cancelled', hint: 'Play was stopped before startup completed.' } };

  function play(policy: PlayDirtyPolicy = 'last-saved', origin: CommandOrigin = 'human'): PlayDispatchResult {
    if (pending) return { ok: true, completion: pending.completion, cancel: pending.stop };
    const lifecycle = deps.lifecycle();
    if (!lifecycle) return { ok: false, error: { code: 'play-unavailable', hint: 'The viewport lifecycle is not ready.' } };
    if (deps.gateway.playPhase === 'play') return { ok: true };
    const dirty = deps.hasPendingDiskSave();
    if (dirty && policy === 'cancel') return { ok: false, error: { code: 'play-cancelled-dirty', hint: 'Play cancelled because the authored scene has unsaved edits.' } };
    let stopped = false;
    let cancel!: () => void;
    const cancellation = new Promise<DispatchResult>((resolve) => {
      cancel = () => { stopped = true; resolve(cancelled); };
    });
    const work = async (): Promise<DispatchResult> => {
      try {
        if (dirty && policy === 'save-then-play') {
          deps.invalidateScene(true);
          deps.gateway.beginPlayAttempt();
          const requestId = globalThis.crypto.randomUUID();
          const accepted = deps.gateway.dispatch({ kind: 'saveDocToDisk', requestId }, origin);
          const saved = accepted.ok ? await deps.gateway.waitOperationRun?.(requestId) : undefined;
          if (stopped) return cancelled;
          if (!accepted.ok || !saved?.ok || saved.value?.status !== 'succeeded') {
            const error = { code: 'play-save-failed' as const, hint: !accepted.ok ? 'Save Then Play could not start the canonical save operation.' : saved?.ok ? saved.value?.error?.hint ?? 'Save did not succeed.' : 'Save completion is unavailable.' };
            deps.invalidateScene(false);
            deps.gateway.failPlayAttempt(error);
            deps.onFailure(error);
            return { ok: false, error };
          }
        }
        if (stopped) return cancelled;
        await lifecycle.playSimulation();
        if (stopped) return cancelled;
        // The lifecycle handles assembly errors internally: Promise resolution
        // alone is not success. Read its authoritative Gateway outcome.
        if (deps.gateway.playPhase === 'play') return { ok: true };
        return { ok: false, error: deps.gateway.lastPlayError ?? { code: 'play-cancelled', hint: 'Play ended without activating a live world.' } };
      } catch (cause) {
        if (stopped) return cancelled;
        const error = { code: 'play-assemble-failed' as const, hint: cause instanceof Error ? cause.message : String(cause) };
        deps.invalidateScene(false);
        deps.gateway.failPlayAttempt(error);
        deps.onFailure(error);
        return { ok: false, error };
      }
    };
    const completion = Promise.race([Promise.resolve().then(work), cancellation]).then((result): DispatchResult =>
      result.ok ? result : { ok: false, error: {
        ...result.error, retryable: result.error.retryable ?? false,
        recoveryActions: result.error.recoveryActions ?? [],
      } },
    );
    const effect = { completion, cancel, stop: () => { if (pending === effect) stop(); } };
    pending = effect;
    void completion.then(() => { if (pending === effect) pending = undefined; });
    return { ok: true, completion, cancel: effect.stop };
  }

  function stop(): void {
    pending?.cancel();
    pending = undefined;
    deps.invalidateScene(false);
    void deps.lifecycle()?.stopSimulation();
  }
  return { play, stop };
}
