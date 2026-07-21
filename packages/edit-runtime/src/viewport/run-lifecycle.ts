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
// (fresh new World() + shared renderer via dispose-shield + disk defaultScene →
// instantiateScene → bootstrap, see play-assemble.ts) → playApp.start() (the one
// live rAF) → gateway.enterPlay(playWorld) (switch the single active-world pointer
// + clear selection + emit). stop = playApp.stop() (dispose-shield keeps the shared
// renderer alive; rAF cancel + renderer.onError unsubscribe → playWorld fully
// unreferenced and GC-able, AC-05) → detach play-side backends → gateway.exitPlay()
// (pointer back to edit world + clear selection + emit) → editorApp.resume().
//
// ── Why this shape (design anchors) ──
// D-2 dual-App mutually-exclusive single driver: at any instant exactly one App
// drives one world (editorApp XOR playApp). The engine App already has the
// start/stop/pause/resume state machine — reuse it, do not hand-roll a frame loop.
// D-2 alt (c): ■ uses playApp.stop(), NOT pause() — pause() would leave the
// renderer.onError subscription live, pinning every play world through
// listener→cleanupFunnel→loop→world and breaking the AC-05 GC promise.
// The dispose-shield (play-assemble.ts) is what makes stop() safe for a SHARED
// renderer (R-N2).
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
//   plan-strategy D-2 (dual-App pause<->start/stop; alt (c) stop()+shield rationale)
//   plan-strategy D-1 (single renderer, draw(world) per-call)
//   requirements AC-04 (level-load play path) / AC-05 (idempotent + GC, dead
//     undo concepts removed) / AC-06 / AC-07 (edit world frozen during play)
//   requirements section 8 (progressive-disclosure header — proposition first)

import type { PlayAssembly } from './play-assemble';
import { Update, type World } from '@forgeax/engine-ecs';

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
  exitPlay(): void;
  // Play-attempt observability (solo round-8 #3). Optional so the headless test's
  // fake gateway (and any older caller) stays compatible — the real EditGateway
  // implements both. beginPlayAttempt marks the async assemble in flight
  // (playPhase → 'starting'); failPlayAttempt records a degraded attempt
  // (playPhase → 'failed' + lastPlayError) so a front-door poller sees a TERMINAL
  // state instead of a mode flip that never comes.
  beginPlayAttempt?(): void;
  failPlayAttempt?(error: { code: string; hint?: string }): void;
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
  /**
   * Assemble a fresh play world + App for one ▶ Play (play-assemble.ts). Called
   * on every ▶ (level-load — a new world each time, never restored). Returns a
   * Result so a failed assemble (bad scene / createApp error) degrades gracefully
   * instead of leaving the editor wedged in a half-play state.
   */
  readonly assemble: () => Promise<AssembleResult>;
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
   * Optional: a per-frame callback to register on the PLAY App's frame loop right
   * after it starts. The edit App is paused during play (editorApp.pause, AC-07),
   * so anything bound to the editor world's Update schedule stops ticking — most importantly
   * the DEV bridge's eval-queue drain, which would otherwise leave a CLI eval
   * submitted during play queued forever. Threading it here lets the drain follow
   * the live app: it is registered on the play App on ▶ and dropped with that app
   * on ■ (GC, no leak). Omitted in headless and in production (bridge is DEV-only).
   */
  readonly onPlayFrame?: () => void;
  /** Called only after the active-world pointer has changed to the live play world. */
  readonly onPlayStarted?: () => void;
  /** Called after a failed assembly has thawed the edit App and recorded its error. */
  readonly onPlayFailed?: () => void;
}

/** The ▶/■ pair + a play-world accessor (GC-reachability assertions in tests). */
export interface RunLifecycle {
  playSimulation(): Promise<void>;
  stopSimulation(): void;
  /** Terminal teardown for viewport realm reset: cancel in-flight play assembly
   *  and stop the live play App before the shared renderer is disposed. */
  dispose(): void;
  /** The live play world while playing, else null. Tests read this to assert the
   *  lifecycle drops its reference on ■ Stop (AC-05 GC reachability proxy). */
  currentPlayWorld(): unknown;
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

  function resumeEditorIfLive(): void {
    if (!editorPaused || disposed) return;
    editorPaused = false;
    deps.editorApp.resume();
  }

  function stopAssembly(assembly: PlayAssembly, label: string): void {
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

  async function playSimulation(): Promise<void> {
    if (disposed) return;
    if (starting) return;
    if (active !== null) return; // already playing — ▶ is a no-op (idempotent)
    const token = ++generation;
    starting = true;

    // solo round-8 #3: mark the async assemble in flight so the gateway's
    // playPhase reads 'starting' — a front-door poller can distinguish
    // "still assembling" from "failed, will never flip". Cleared on success
    // (enterPlay) or set to 'failed' below.
    deps.gateway.beginPlayAttempt?.();

    // D-10: if the doc has unsaved edits, hint that play uses the last-saved
    // scene (disk re-instantiate does not see in-memory edits).
    deps.onDirtyPlayHint?.();

    // D-2 / AC-07: freeze the edit world FIRST (pause its frame loop → zero tick).
    // Do this before assembling so the edit world is already still while the play
    // world spins up.
    deps.editorApp.pause();
    editorPaused = true;

    // Assemble the fresh play world + App (level-load, AC-04). On failure, thaw
    // the edit world and stay in edit mode (graceful degradation — never leave the
    // editor wedged mid-play).
    const res = await deps.assemble();
    starting = false;
    if (disposed || token !== generation) {
      if (res.ok) stopAssembly(res.value, '▶ Play canceled');
      return;
    }
    if (!res.ok) {
      console.warn('[editor] ▶ Play assemble failed:', res.error);
      resumeEditorIfLive();
      // solo round-8 #3: surface the failure through the front door so playPhase
      // reads 'failed' + lastPlayError carries why — instead of silently degrading
      // to edit while dispatch already returned {ok:true} (the round-3/5 trap).
      // Normalize the loose assemble error into a hint string (CommandError.hint is
      // required): a structured error contributes its own hint, an Error its message,
      // anything else is stringified.
      const err = res.error;
      const structured = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : null;
      const hint = structured && typeof structured.hint === 'string'
        ? structured.hint
        : err instanceof Error
          ? err.message
          : String(err);
      deps.gateway.failPlayAttempt?.({ code: 'play-assemble-failed', hint });
      deps.onPlayFailed?.();
      return;
    }
    active = res.value;

    // Start the play App's frame loop — now the single live rAF driving the
    // play world (D-2). The shared renderer draws the play world per-frame (D-1).
    const startR = active.playApp.start();
    if (!startR.ok) {
      console.warn('[editor] ▶ Play playApp.start() failed:', startR.error);
    }

    // Follow-the-live-world: the edit app is paused, so attach the bridge drain
    // to the play world's Update schedule for the duration of this play assembly.
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
    deps.onPlayStarted?.();

    // Host camera pickup (AC-12 hard cut). Omitted in headless.
    deps.onAfterPlay?.(active.playWorld);
  }

  function stopSimulation(): void {
    if (starting) {
      generation++;
      starting = false;
      try { deps.gateway.exitPlay(); } catch { /* best effort while canceling start */ }
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
    // renderer.onError, so nothing pins the play world (AC-05 GC). The
    // dispose-shield (play-assemble.ts) keeps the SHARED renderer alive through
    // stop()'s unconditional renderer.dispose() (R-N2).
    stopAssembly(assembly, '■ Stop');

    // D-3: pointer back to the edit world (clears selection + emits so panels
    // re-read the edit world's hierarchy).
    deps.gateway.exitPlay();

    // D-2 / AC-07: thaw the edit world — resume its frame loop.
    resumeEditorIfLive();

    // assembly (and thus playWorld/playApp) is now unreferenced by the lifecycle
    // → GC-able (AC-05). No restore, no rebind, no despawn.
  }

  function dispose(): void {
    if (disposed) return;
    const wasStarting = starting;
    disposed = true;
    generation++;
    starting = false;
    const assembly = active;
    active = null;
    if (assembly !== null) {
      stopAssembly(assembly, 'run-lifecycle dispose');
      try { deps.gateway.exitPlay(); } catch { /* best effort during realm teardown */ }
    } else if (wasStarting) {
      try { deps.gateway.exitPlay(); } catch { /* best effort during realm teardown */ }
    }
    editorPaused = false;
  }

  function currentPlayWorld(): unknown {
    return active === null ? null : active.playWorld;
  }

  return { playSimulation, stopSimulation, dispose, currentPlayWorld };
}
