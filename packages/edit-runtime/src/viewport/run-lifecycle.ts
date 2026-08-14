// run-lifecycle.ts — ▶ Play / ■ Stop for the editor: play=level-load, stop=drop,
// no restore concept.
//
// feat-20260707-editor-world-fork-ssot-level-load-play-activeworld M2.
//
// Proposition (P1 progressive disclosure): ▶ Play forks a FRESH play world and
// drives it on its own frame loop while the edit world sits frozen; ■ Stop drops
// that world whole and thaws the edit world. There is no snapshot, no restore, no
// undo — the edit world was never touched, so there is nothing to put back.
//
// ── The whole model in one paragraph ──
// play = editorApp.pause() (edit world zero tick, AC-07) → assemblePlayWorld
// (fresh new World() + host-owned shared renderer + disk defaultScene →
// instantiateScene → bootstrap, see play-assemble.ts) → playApp.start() (the one
// live rAF) → gateway.enterPlay(playWorld) (switch the single active-world pointer
// + clear selection + emit). stop = playApp.stop() (rAF cancel +
// renderer.onError unsubscribe → detach play-side
// backends → destroy the play World's GPU residency once → gateway.exitPlay()
// (pointer back to edit world + clear selection + emit) → editorApp.resume().
//
// ── Why this shape (design anchors) ──
// D-2 dual-App mutually-exclusive single driver: at any instant exactly one App
// drives one world (editorApp XOR playApp). The engine App already has the
// start/stop/pause/resume state machine — reuse it, do not hand-roll a frame loop.
// D-2 alt (c): ■ uses playApp.stop(), NOT pause() — pause() would leave the
// renderer.onError subscription live, pinning every play world through
// listener→cleanupFunnel→loop→world and breaking the AC-05 GC promise.
// Assemble-form App does not own the renderer, so stop is safe for a shared host.
//
// ── What is deliberately GONE vs the old original-in-place ▶ Play ──
// The old four-layer stop-time undo (a system-name diff, a run-generation frame
// guard, a live-handle diff despawn, and a document-snapshot re-projection) is
// deleted (AC-05): a fresh-world-per-play model has nothing to undo. The scene
// re-bind callback is gone too (M3 removes its only remaining consumer). The dead
// vocabulary is scrubbed from this source so a grep for those concepts over
// edit-runtime returns nothing (AC-05 discoverability sweep).
//
// Dependency-injected (Pipeline Isolation): host-boot wires the real editorApp /
// gateway / assemble; the headless test wires fakes and drives the whole
// play→stop→play cycle deterministically (bun has no rAF).
//
// Anchors:
//   plan-strategy D-2 (dual-App pause<->start/stop)
//   plan-strategy D-1 (single renderer, draw(world) per-call)
//   requirements AC-04 (level-load play path) / AC-05 (idempotent + GC, dead
//     undo concepts removed) / AC-06 / AC-07 (edit world frozen during play)
//   requirements section 8 (progressive-disclosure header — proposition first)

import type { PlayAssembly } from './play-assemble';
import { FrameEnd, Update, type World } from '@forgeax/engine-ecs';

export interface LiveWorldPublisherGraph {
  bindWorld(world: unknown): number;
  unbindWorld(expectedWorld?: unknown): boolean;
  publish(options?: { readonly world?: unknown; readonly worldGeneration?: number }): unknown;
}

export interface LiveWorldFrameEndWorld {
  addSystem: (schedule: typeof FrameEnd, descriptor: { name: string; queries: readonly []; fn: () => void }) => unknown;
  removeSystem: (schedule: typeof FrameEnd, name: string) => unknown;
}

export interface LiveWorldFrameEndPublisher {
  bind(world: LiveWorldFrameEndWorld): void;
  publishFrameEnd(): void;
  unbind(world: LiveWorldFrameEndWorld): void;
}

export function createLiveWorldFrameEndPublisher(graph: LiveWorldPublisherGraph): LiveWorldFrameEndPublisher {
  let activeWorld: LiveWorldFrameEndWorld | null = null;
  let generation = 0;
  const systemName = 'editor-runtime-ui-publisher';
  return {
    bind(world) {
      if (activeWorld === world) return;
      if (activeWorld !== null) {
        try { graph.unbindWorld(activeWorld); } catch { /* preserve the new bind */ }
      }
      generation = graph.bindWorld(world);
      world.addSystem(FrameEnd, { name: systemName, queries: [], fn: () => graph.publish({ world, worldGeneration: generation }) });
      activeWorld = world;
    },
    publishFrameEnd() {
      if (activeWorld !== null) graph.publish({ world: activeWorld, worldGeneration: generation });
    },
    unbind(world) {
      try { world.removeSystem(FrameEnd, systemName); } catch { /* cleanup continues */ }
      try { graph.unbindWorld(world); } catch { /* adjacent teardown cannot block unbind */ }
      if (activeWorld === world) activeWorld = null;
    },
  };
}

// ── loose engine handles (the ECS/App/renderer types evolve independently; keep
// the `as never`/structural discipline used across this package) ──────────────

/** The editor App handle — pause() on ▶, resume() on ■ (D-2). Structural. */
export interface EditorAppHandle {
  pause(): { ok: boolean; error?: unknown };
  resume(): { ok: boolean; error?: unknown };
}

/** The gateway single-pointer surface (M1 D-3). Structural mirror of EditGateway. */
export interface RunGateway {
  enterPlay(playWorld: unknown): void;
  enterRemotePlay?(): void;
  exitPlay(): void;
  // Play-attempt observability. beginPlayAttempt marks the async assemble in flight
  // (playPhase → 'starting'); failPlayAttempt records a degraded attempt
  // (playPhase → 'failed' + lastPlayError) so a front-door poller sees a TERMINAL
  // state instead of a mode flip that never comes.
  beginPlayAttempt(): void;
  failPlayAttempt(error: { code: string; hint?: string }): void;
}

export interface RemotePlayCarrier {
  start(): Promise<{ ok: true } | { ok: false; error: { code: string; hint: string } }>;
  stop(): Promise<{ ok: true } | { ok: false; error: { code: string; hint: string } }>;
  pause(): void;
  resume(): void;
  state(): 'edit' | 'entering-play' | 'play' | 'stopping';
}

/** Optional OperationRun projection supplied by the product host. */
export interface RunLifecycleRunProjection {
  accepted(operationId: string): string;
  running(runId: string): void;
  succeeded(runId: string, result?: unknown): void;
  failed(runId: string, error: { code: string; hint: string; retryable?: boolean; recoveryActions?: readonly string[] }): void;
  cancelled(runId: string): void;
}

/** The assembly result the lifecycle drives (from play-assemble.ts). */
type AssembleResult = { ok: true; value: PlayAssembly } | { ok: false; error: unknown };

/**
 * Everything createRunLifecycle needs, declared explicitly (Pipeline Isolation).
 * No implicit globals — the headless test supplies a real editorApp + fake gateway
 * + an assemble that runs the real engine assemble path against a fake renderer.
 */
export interface RunLifecycleDeps {
  /** The editor App — paused on ▶ (edit world zero tick, AC-07), resumed on ■. */
  readonly editorApp: EditorAppHandle;
  /** The gateway — enterPlay/exitPlay switch the single active-world pointer (D-3). */
  readonly gateway: RunGateway;
  /** Editor-owned FrameEnd publisher; Studio never owns this lifecycle state. */
  readonly publisher?: LiveWorldFrameEndPublisher;
  /** The edit World restored after stopping a play World. */
  readonly editWorld?: unknown;
  /** Optional run projection; omitted by older viewport-only hosts. */
  readonly runProjection?: RunLifecycleRunProjection;
  /**
   * Assemble a fresh play world + App for one ▶ Play (play-assemble.ts). Called
   * on every ▶ (level-load — a new world each time, never restored). Returns a
   * Result so a failed assemble (bad scene / createApp error) degrades gracefully
   * instead of leaving the editor wedged in a half-play state.
   */
  readonly assemble: () => Promise<AssembleResult>;
  /** When present, PlayWorld lives in a disposable child realm instead of this realm. */
  readonly remoteCarrier?: RemotePlayCarrier;
  /**
   * Optional: called after a successful play assembly so the host can pick up a
   * camera the game spawned + re-derive the active camera. Omitted in headless.
   */
  readonly onAfterPlay?: (playWorld: unknown) => void;
  /**
   * Optional: called on ▶ Play when the gateway has unsaved edits, so the host can
   * surface the D-10 `play-uses-last-saved-scene` hint (play re-instantiates from
   * disk, so unsaved in-memory edits are not reflected). Omitted in headless.
   */
  readonly onDirtyPlayHint?: () => void;
  /**
   * Optional DEV bridge callback to register on the PLAY App's frame loop right
   * after it starts. The edit App is paused during play (editorApp.pause, AC-07),
   * so anything bound to the editor world's Update schedule stops ticking — most importantly
   * the DEV bridge's eval-queue drain, which would otherwise leave a CLI eval
   * submitted during play queued forever. Threading it here lets the drain follow
   * the live app: it is registered on the play App on ▶ and dropped with that app
   * on ■ (GC, no leak). It is not a runtime UI invalidation signal.
   */
  readonly onPlayFrame?: () => void;
  /** Called only after the active-world pointer has changed to the live play world. */
  readonly onPlayStarted?: (playWorld: unknown) => void;
  readonly onRemotePlayStarted?: () => void;
  /** Called after a failed assembly has thawed the edit App and recorded its error. */
  readonly onPlayFailed?: () => void;
}

/** The ▶/■ pair + a play-world accessor (GC-reachability assertions in tests). */
export interface RunLifecycle {
  playSimulation(): Promise<void>;
  stopSimulation(): void | Promise<void>;
  /** Terminal teardown for viewport realm reset: cancel in-flight play assembly
   *  and stop the live play App before the shared renderer is disposed. */
  dispose(): void;
  /** The live play world while playing, else null. Tests read this to assert the
   *  lifecycle drops its reference on ■ Stop (AC-05 GC reachability proxy). */
  currentPlayWorld(): unknown;
  /** The live play App's pause/resume handle while playing, else null.
   *  Used by installVisibilityPause to pause the correct app when the viewport
   *  is hidden during Play mode. */
  getPlayPauseHandle(): { pause(): void; resume(): void } | null;
  currentPlayRunId(): string | null;
}

/**
 * Build the ▶ Play / ■ Stop pair. See file header for the full model.
 *
 * State: a single `active` slot holds the current play assembly (or null in edit
 * mode). playSimulation is a no-op if already playing; stopSimulation is a no-op
 * (idempotent) if not playing — so a stray second ■ does nothing (AC-05).
 */
export function createRunLifecycle(deps: RunLifecycleDeps): RunLifecycle {
  // The single play slot. Non-null exactly while a play run is active. Dropping
  // it on ■ (active = null) releases the lifecycle's only reference to the play
  // world/app so they become GC-able (AC-05).
  let active: PlayAssembly | null = null;
  let starting = false;
  let disposed = false;
  let generation = 0;
  let editorPaused = false;
  let playRunId: string | null = null;
  let remoteActive = false;

  function resumeEditorIfLive(): void {
    if (!editorPaused || disposed) return;
    editorPaused = false;
    deps.editorApp.resume();
  }

  function stopAssembly(assembly: PlayAssembly, label: string): void {
    try {
      assembly.detachBeforeStop?.();
    } catch (err) {
      console.warn(`[editor] ${label} detachBeforeStop() threw:`, err);
    }
    try { assembly.clearGameProjection?.(); } catch (err) {
      console.warn(`[editor] ${label} clearGameProjection() threw:`, err);
    }
    try {
      const stopR = assembly.playApp.stop();
      if (!stopR.ok) console.warn(`[editor] ${label} playApp.stop() failed:`, stopR.error);
    } catch (err) {
      console.warn(`[editor] ${label} playApp.stop() threw:`, err);
    }

    try {
      assembly.detach();
    } catch (err) {
      console.warn(`[editor] ${label} detach() threw:`, err);
    }
  }

  function reportPlayFailure(error: unknown): void {
    const structured = typeof error === 'object' && error !== null ? error as Record<string, unknown> : null;
    let hint = String(error);
    if (error instanceof Error) hint = error.message;
    if (structured && typeof structured.hint === 'string') hint = structured.hint;
    const code = structured && typeof structured.code === 'string'
      ? structured.code
      : 'play-assemble-failed';
    deps.gateway.failPlayAttempt({ code, hint });
    if (playRunId !== null) {
      deps.runProjection?.failed(playRunId, { code, hint, retryable: true, recoveryActions: ['operation.retry'] });
      playRunId = null;
    }
    deps.onPlayFailed?.();
  }

  async function playSimulation(): Promise<void> {
    if (disposed) return;
    if (starting) return;
    if (active !== null) return; // already playing — ▶ is a no-op (idempotent)
    const token = ++generation;
    starting = true;
    playRunId = deps.runProjection?.accepted('play') ?? null;
    if (playRunId !== null) deps.runProjection?.running(playRunId);

    // solo round-8 #3: mark the async assemble in flight so the gateway's
    // playPhase reads 'starting' — a front-door poller can distinguish
    // "still assembling" from "failed, will never flip". Cleared on success
    // (enterPlay) or set to 'failed' below.
    deps.gateway.beginPlayAttempt();

    // D-10: if the doc has unsaved edits, hint that play uses the last-saved
    // scene (disk re-instantiate does not see in-memory edits).
    deps.onDirtyPlayHint?.();

    if (deps.remoteCarrier !== undefined) {
      const remote = await deps.remoteCarrier.start();
      starting = false;
      if (disposed || token !== generation) {
        if (remote.ok) await deps.remoteCarrier.stop();
        return;
      }
      if (!remote.ok) {
        reportPlayFailure(remote.error);
        return;
      }
      remoteActive = true;
      deps.gateway.enterRemotePlay?.();
      deps.onRemotePlayStarted?.();
      if (playRunId !== null) {
        deps.runProjection?.succeeded(playRunId, { phase: 'play', carrier: 'iframe' });
        playRunId = null;
      }
      return;
    }

    // D-2 / AC-07: freeze the edit world FIRST (pause its frame loop → zero tick).
    // Do this before assembling so the edit world is already still while the play
    // world spins up.
    deps.editorApp.pause();
    editorPaused = true;

    // Assemble the fresh play world + App (level-load, AC-04). On failure, thaw
    // the edit world and stay in edit mode (graceful degradation — never leave the
    // editor wedged mid-play).
    let res: AssembleResult;
    try {
      res = await deps.assemble();
    } catch (error) {
      starting = false;
      if (disposed || token !== generation) return;
      console.error('[editor] ▶ Play assemble threw:', error);
      resumeEditorIfLive();
      reportPlayFailure(error);
      return;
    }
    starting = false;
    if (disposed || token !== generation) {
      if (res.ok) stopAssembly(res.value, '▶ Play canceled');
      return;
    }
    if (!res.ok) {
      console.error('[editor] ▶ Play assemble failed:', res.error);
      resumeEditorIfLive();
      // solo round-8 #3: surface the failure through the front door so playPhase
      // reads 'failed' + lastPlayError carries why — instead of silently degrading
      // to edit while dispatch already returned {ok:true} (the round-3/5 trap).
      reportPlayFailure(res.error);
      return;
    }
    active = res.value;

    deps.publisher?.bind(active.playWorld as LiveWorldFrameEndWorld);

    // Start the play App's frame loop — now the single live rAF driving the
    // play world (D-2). The shared renderer draws the play world per-frame (D-1).
    const startR = active.playApp.start();
    if (!startR.ok) {
      console.error('[editor] ▶ Play playApp.start() failed:', startR.error);
      const failedAssembly = active;
      active = null;
      stopAssembly(failedAssembly, '▶ Play start failure');
      deps.publisher?.unbind(failedAssembly.playWorld as LiveWorldFrameEndWorld);
      if (deps.editWorld !== undefined) deps.publisher?.bind(deps.editWorld as LiveWorldFrameEndWorld);
      resumeEditorIfLive();
      reportPlayFailure(startR.error ?? { code: 'play-renderer-failed', hint: 'The Play renderer could not start.' });
      return;
    }

    // Follow-the-live-world bridge: the edit app is paused, so attach the eval
    // drain to the play world's Update schedule for the duration of this assembly.
    // Runtime UI refresh is owned by the FrameEnd publisher below.
    if (deps.onPlayFrame) {
      (active.playWorld as World).addSystem(Update, {
        name: 'editor-play-bridge-eval-drain',
        queries: [],
        fn: deps.onPlayFrame,
      }).unwrap();
    }

    // D-3: switch the single active-world pointer to the play world (clears
    // selection + emits so panels re-read the play world's hierarchy).
    deps.gateway.enterPlay(active.playWorld);
    // A game projection becomes visible only after activeWorld points at the same
    // fresh world its bootstrap captured. Its teardown is coupled to assembly.detach.
    active.installGameProjection?.();

    // The host exposes run='play' only after activeWorld points at this same live
    // world, so Hierarchy and viewport chrome never claim Play while still reading
    // the frozen edit document during asynchronous assembly.
    deps.onPlayStarted?.(active.playWorld);
    if (playRunId !== null) {
      deps.runProjection?.succeeded(playRunId, { phase: 'play' });
      playRunId = null;
    }

    // Host camera pickup (AC-12 hard cut). Omitted in headless.
    deps.onAfterPlay?.(active.playWorld);
  }

  async function stopSimulation(): Promise<void> {
    if (remoteActive && deps.remoteCarrier !== undefined) {
      remoteActive = false;
      await deps.remoteCarrier.stop();
      deps.gateway.exitPlay();
      playRunId = null;
      deps.onPlayFailed?.();
      return;
    }
    if (starting) {
      generation++;
      starting = false;
      try { deps.gateway.exitPlay(); } catch { /* best effort while canceling start */ }
      if (playRunId !== null) {
        deps.runProjection?.cancelled(playRunId);
        playRunId = null;
      }
      resumeEditorIfLive();
      deps.onPlayFailed?.();
      return;
    }
    if (active === null) return; // not playing — ■ is a no-op (idempotent, AC-05)
    const assembly = active;
    // Drop the slot reference FIRST so even if a teardown step throws, the
    // lifecycle is already back in edit state (no wedged half-play).
    active = null;

    // D-2 alt (c): stop() (NOT pause()) — cancels the rAF AND unsubscribes
    // renderer.onError, so nothing pins the play world (AC-05 GC). Assemble-form
    // App owns the loop but not the shared renderer.
    stopAssembly(assembly, '■ Stop');
    deps.publisher?.unbind(assembly.playWorld as LiveWorldFrameEndWorld);
    if (deps.editWorld !== undefined) deps.publisher?.bind(deps.editWorld as LiveWorldFrameEndWorld);

    // D-3: pointer back to the edit world (clears selection + emits so panels
    // re-read the edit world's hierarchy).
    deps.gateway.exitPlay();
    playRunId = null;

    // D-2 / AC-07: thaw the edit world — resume its frame loop.
    resumeEditorIfLive();

    // assembly (and thus playWorld/playApp) is now unreferenced by the lifecycle
    // → GC-able (AC-05). Its World-scoped GPU residency was destroyed once above;
    // there is no restore, rebind, or despawn.
  }

  function dispose(): void {
    if (disposed) return;
    const wasPlaying = active !== null || starting || remoteActive;
    const wasStarting = starting;
    disposed = true;
    generation++;
    starting = false;
    const assembly = active;
    active = null;
    if (assembly !== null) {
      stopAssembly(assembly, 'run-lifecycle dispose');
      deps.publisher?.unbind(assembly.playWorld as LiveWorldFrameEndWorld);
      if (deps.editWorld !== undefined) deps.publisher?.bind(deps.editWorld as LiveWorldFrameEndWorld);
      try { deps.gateway.exitPlay(); } catch { /* best effort during realm teardown */ }
    } else if (wasStarting) {
      try { deps.gateway.exitPlay(); } catch { /* best effort during realm teardown */ }
      if (playRunId !== null) deps.runProjection?.cancelled(playRunId);
    }
    if (remoteActive && deps.remoteCarrier !== undefined) {
      remoteActive = false;
      void deps.remoteCarrier.stop();
      try { deps.gateway.exitPlay(); } catch { /* best effort during realm teardown */ }
    }
    playRunId = null;
    editorPaused = false;
    if (wasPlaying) deps.onPlayFailed?.();
  }

  function currentPlayWorld(): unknown {
    return active === null ? null : active.playWorld;
  }

  function getPlayPauseHandle(): { pause(): void; resume(): void } | null {
    if (deps.remoteCarrier !== undefined && deps.remoteCarrier.state() !== 'edit') {
      return {
        pause() { deps.remoteCarrier!.pause(); },
        resume() { deps.remoteCarrier!.resume(); },
      };
    }
    if (!active) return null;
    const pa = active.playApp;
    return {
      pause() { pa.pause(); },
      resume() { pa.resume(); },
    };
  }

  function currentPlayRunId(): string | null {
    return playRunId;
  }

  return { playSimulation, stopSimulation, dispose, currentPlayWorld, getPlayPauseHandle, currentPlayRunId };
}
