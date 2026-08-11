import type { ViewportCarrierKind } from '../contracts/viewport-runtime';

export interface PreparedViewportCarrier {
  readonly carrierId: string;
  readonly carrierKind: Extract<ViewportCarrierKind, 'iframe' | 'browser-page' | 'tauri-webview'>;
  /** Starts the authoritative Runtime only after the previous carrier has stopped. */
  start(runtimeGeneration: number): Promise<{ ok: true } | { ok: false; error: { code: string; hint: string } }>;
  waitFirstFrame(): Promise<{ ok: true } | { ok: false; error: { code: string; hint: string } }>;
  stop(): Promise<void>;
  disposePrepared(): void | Promise<void>;
}

export interface ActiveViewportCarrier extends PreparedViewportCarrier {
  readonly runtimeGeneration: number;
}

export type ViewportRelocationResult =
  | { readonly ok: true; readonly carrier: ActiveViewportCarrier }
  | { readonly ok: false; readonly error: { readonly code: string; readonly hint: string; readonly rolledBack: boolean } };

export interface ViewportRelocationController {
  relocate(kind: PreparedViewportCarrier['carrierKind']): Promise<ViewportRelocationResult>;
  active(): ActiveViewportCarrier;
  phase(): 'active' | 'preparing' | 'saving' | 'switching' | 'rolling-back';
}

/** Save-first Runtime restart. Target preparation is renderer-free; only one started carrier holds the lease. */
export function createViewportRelocationController(deps: {
  readonly initial: ActiveViewportCarrier;
  readonly prepare: (kind: PreparedViewportCarrier['carrierKind']) => Promise<PreparedViewportCarrier>;
  readonly save: () => Promise<{ ok: true } | { ok: false; error: { code: string; hint: string } }>;
}): ViewportRelocationController {
  let active = deps.initial;
  let phase: ReturnType<ViewportRelocationController['phase']> = 'active';
  let relocating = false;

  async function relocate(kind: PreparedViewportCarrier['carrierKind']): Promise<ViewportRelocationResult> {
    if (relocating) return { ok: false, error: { code: 'viewport-relocation-active', hint: 'Another Viewport relocation already owns the transition.', rolledBack: false } };
    if (kind === active.carrierKind) return { ok: true, carrier: active };
    relocating = true;
    phase = 'preparing';
    let target: PreparedViewportCarrier;
    try {
      target = await deps.prepare(kind);
    } catch (error) {
      relocating = false;
      phase = 'active';
      return { ok: false, error: { code: 'viewport-target-unavailable', hint: error instanceof Error ? error.message : String(error), rolledBack: false } };
    }

    phase = 'saving';
    const saved = await deps.save();
    if (!saved.ok) {
      await target.disposePrepared();
      relocating = false;
      phase = 'active';
      return { ok: false, error: { ...saved.error, rolledBack: false } };
    }

    const previous = active;
    const nextGeneration = previous.runtimeGeneration + 1;
    phase = 'switching';
    await previous.stop();
    const started = await target.start(nextGeneration);
    const ready = started.ok ? await target.waitFirstFrame() : null;
    if (started.ok && ready?.ok) {
      await previous.disposePrepared();
      active = { ...target, runtimeGeneration: nextGeneration };
      relocating = false;
      phase = 'active';
      return { ok: true, carrier: active };
    }

    await target.stop().catch(() => {});
    await target.disposePrepared();
    phase = 'rolling-back';
    const restored = await previous.start(nextGeneration + 1);
    const restoredReady = restored.ok ? await previous.waitFirstFrame() : restored;
    relocating = false;
    phase = 'active';
    if (restored.ok && restoredReady.ok) {
      active = { ...previous, runtimeGeneration: nextGeneration + 1 };
      const failure = !started.ok ? started.error : ready !== null && !ready.ok
        ? ready.error
        : { code: 'viewport-target-failed', hint: 'The target Runtime did not reach its first frame.' };
      return { ok: false, error: { code: failure.code, hint: failure.hint, rolledBack: true } };
    }
    const rollbackFailure = !restored.ok ? restored.error : !restoredReady.ok
      ? restoredReady.error
      : { code: 'viewport-rollback-failed', hint: 'The previous Runtime did not resume.' };
    return { ok: false, error: {
      code: 'viewport-relocation-rollback-failed',
      hint: rollbackFailure.hint,
      rolledBack: false,
    } };
  }

  return { relocate, active: () => active, phase: () => phase };
}
