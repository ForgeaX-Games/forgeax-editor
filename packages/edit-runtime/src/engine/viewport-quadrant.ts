// Viewport quadrant state — the {run, display} SSOT for the 2×2 viewport model
// (requirements §3, item 3: the viewport panel holds local run + display state,
// and input ownership is a derived selector). This is the single source of truth
// for those two axes; every derived quantity (inputTarget, and later activeCamera
// / aux-visibility) falls out of it — nothing else stores run or display
// independently (C-4).
//
// M4 ships the minimal holder the input-gating / pointer-lock / possess / transient
// tasks (w17/w19/w20/w27) need to read and flip the quadrant. The full state
// machine + programmable API (w22, M5) ENRICHES this module (activeCamera
// derivation, consumer fan-out to the display-visibility bus + ViewportBar); it
// does not replace it. Keeping the SSOT here from M4 means w22 extends one module
// rather than migrating scattered state.

import { deriveInputTarget, type RunMode, type DisplayMode, type InputTarget } from './viewport';

export type { RunMode, DisplayMode, InputTarget };

/** The full quadrant snapshot: the two authoritative axes + the derived owner. */
export interface ViewportQuadrant {
  readonly run: RunMode;
  readonly display: DisplayMode;
  /** Derived (C-4) — never set independently. */
  readonly inputTarget: InputTarget;
}

// Default entry state is edit·scene (requirements AC-03: first open → run=edit,
// display=scene; aids + ViewportBar on, game logic stopped).
let run: RunMode = 'edit';
let display: DisplayMode = 'scene';

type QuadrantListener = (q: ViewportQuadrant) => void;
const listeners = new Set<QuadrantListener>();

/** Current quadrant snapshot. inputTarget is recomputed each read (pure derive). */
export function getViewportQuadrant(): ViewportQuadrant {
  return { run, display, inputTarget: deriveInputTarget(run, display) };
}

/** The derived input owner for the current quadrant (C-4). The viewport input
 *  gate (w17) and the pointer-lock gate (w19) both read THIS — one derivation. */
export function getInputTarget(): InputTarget {
  return deriveInputTarget(run, display);
}

/** Patch run and/or display, then notify subscribers. Only ▶/■ move `run`
 *  (and they own the simulation lifecycle elsewhere); G / possess move `display`.
 *  inputTarget is never accepted here — it is derived, not stored (C-4). */
export function setViewportQuadrant(patch: { run?: RunMode; display?: DisplayMode }): void {
  const nextRun = patch.run ?? run;
  const nextDisplay = patch.display ?? display;
  if (nextRun === run && nextDisplay === display) return;
  run = nextRun;
  display = nextDisplay;
  const snap = getViewportQuadrant();
  for (const fn of listeners) fn(snap);
}

/** Subscribe to quadrant changes; returns an unsubscribe. */
export function onViewportQuadrantChange(fn: QuadrantListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
