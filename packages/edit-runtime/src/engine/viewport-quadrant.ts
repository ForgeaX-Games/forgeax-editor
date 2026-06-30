// Viewport quadrant state — the {run, display} SSOT for the 2×2 viewport model
// (requirements §3, item 3: the viewport panel holds local run + display state,
// and input ownership is a derived selector). This is the single source of truth
// for those two axes; every derived quantity (inputTarget, activeCamera entity,
// auxiliary-visibility) falls out of it — nothing else stores run or display
// independently (C-4).
//
// M4 ships the minimal holder the input-gating / pointer-lock / possess / transient
// tasks (w17/w19/w20/w27) need to read and flip the quadrant. w22 (M5) enriches
// this module with activeCamera derivation and camera-entity registration so the
// renderer can switch between the editor orbit camera and the game camera per
// quadrant — the engine stays neutral (OOS-4), receiving only an entity id.
//
// Programmable API (§10.1): getViewportQuadrant / setViewportQuadrant are the
// single SSOT entry points for both human UI gestures (ViewportBar) and scripted
// AI users — same surface, same semantics (charter P4).

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

// ── camera entity registration (w22) ────────────────────────────────────────
// The engine's ActiveCamera resource (w12) receives an entity id; the editor
// decides WHICH entity that is based on the current quadrant. The editor orbit
// camera is spawned at boot (main.tsx cameraEntity); the game camera entity is
// discovered from the game scene. These two ids are registered here so the
// quadrant module can derive the active camera for any quadrant without holding
// a world reference.

let editorCameraEntity: number | undefined;
let gameCameraEntity: number | undefined;

/**
 * Register the editor's orbit-camera entity so the quadrant module can derive
 * which camera should be active.
 */
export function setEditorCameraEntity(entity: number): void {
  editorCameraEntity = entity;
}

/**
 * Register the game's camera entity (discovered from the authored scene or
 * explicitly set by game logic). `undefined` means "no game camera found" —
 * the renderer falls back to its first-hit behavior (D-8).
 */
export function setGameCameraEntity(entity: number | undefined): void {
  gameCameraEntity = entity;
}

/**
 * Derive the entity id of the camera that should be active for the current
 * quadrant. This is a PURE derivation from {run, display} + the registered
 * camera entities — no side effects.
 *
 * - play·game: use the game camera (if registered), otherwise fall back to
 *   `undefined` (the renderer handles the no-camera case per D-8).
 * - all other quadrants: use the editor orbit camera.
 *
 * Returns `undefined` when no camera is registered for the derived quadrant.
 */
export function deriveActiveCameraEntity(): number | undefined {
  if (run === 'play' && display === 'game') {
    return gameCameraEntity; // may be undefined → renderer fallback (D-8)
  }
  return editorCameraEntity;
}

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
