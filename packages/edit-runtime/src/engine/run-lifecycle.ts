// run-lifecycle.ts — bootstrap-entry ▶ Play / ■ Stop for the edit world.
//
// feat-20260630-viewport-2x2-run-x-display-redesign M2 (w8/w9/w11/w12).
// plan-strategy D-1 / D-1a / D-1b / D-1c.
//
// WHY a separate module: main.tsx is a side-effectful entry (createApp, DOM,
// top-level await). It cannot be imported under `bun:test`. The run lifecycle —
// the epoch guard (D-1c) and playSimulation / stopSimulation (D-1 / D-1c) — is
// the part that needs deterministic unit + integration coverage (w8 / w9), so it
// lives here as a dependency-injected factory. main.tsx wires the real world /
// app / bus / engineSync into `createRunLifecycle` and exposes the returned
// play / stop to the ViewportBar. No engine code is touched — loadGame /
// BootstrapContext / world.removeSystem are all pre-existing engine surface.
//
// charter awareness: F1 (one epoch concept) + P3 (structured failure) + OOS-4
// (zero editor semantics reach the engine — the engine sees entity ids only).

// ────────────────────────────────────────────────────────────────────────────
// D-1c layer 2 — run-generation epoch guard (pure)
// ────────────────────────────────────────────────────────────────────────────

/**
 * A run-generation guard. `wrap(fn)` captures the CURRENT epoch and returns a
 * callback that only forwards to `fn` while the epoch is unchanged; `bump()`
 * advances the epoch so every callback wrapped in a prior generation becomes a
 * silent no-op.
 *
 * This is the D-1c layer-2 undo channel for `ctx.registerUpdate`: the engine
 * frame loop has `addUpdateCallback` but no remove counterpart
 * (frame-loop.ts). Rather than grow the engine surface with a remove API for an
 * editor lifecycle need (OOS-4), ■ Stop bumps the epoch and the accumulated
 * callbacks from the stopped run go dormant in place.
 *
 * Pure: depends only on its own closed-over counter — no world, no frame loop.
 */
export interface EpochGuard {
  /** Wrap a per-frame callback so it only runs while its capture-time epoch is current. */
  wrap(fn: (dt: number) => void): (dt: number) => void;
  /** Advance the generation; all previously wrapped callbacks go no-op. */
  bump(): void;
  /** Current generation counter (for assertions / diagnostics). */
  current(): number;
}

/** Construct an {@link EpochGuard}. Starts at generation 0. */
export function makeEpochGuard(): EpochGuard {
  let epoch = 0;
  return {
    wrap(fn: (dt: number) => void): (dt: number) => void {
      const my = epoch;
      return (dt: number) => {
        if (my === epoch) fn(dt);
      };
    },
    bump(): void {
      epoch += 1;
    },
    current(): number {
      return epoch;
    },
  };
}
