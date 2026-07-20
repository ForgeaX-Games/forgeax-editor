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

import { deriveInputTarget, type RunMode, type DisplayMode, type InputTarget, type ControlOwner } from './viewport';

export type { RunMode, DisplayMode, InputTarget, ControlOwner };

/** The viewport facts are independent: simulation, presentation, and explicit input lease. */
export interface ViewportQuadrant {
  readonly run: RunMode;
  readonly display: DisplayMode;
  readonly control: ControlOwner;
  /** Derived from run + control — display must never grant gameplay input. */
  readonly inputTarget: InputTarget;
}

// Default entry state is edit·scene with editor control. Starting Play preserves
// editor control until a trusted canvas gesture explicitly grants the game lease.
let run: RunMode = 'edit';
let display: DisplayMode = 'scene';
let control: ControlOwner = 'editor';

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

/** Current viewport snapshot. inputTarget remains a pure derivation. */
export function getViewportQuadrant(): ViewportQuadrant {
  return { run, display, control, inputTarget: deriveInputTarget(run, control) };
}

/** The derived consumer of canvas input for the current control lease. */
export function getInputTarget(): InputTarget {
  return deriveInputTarget(run, control);
}

/**
 * Patch the explicit viewport facts. A non-playing or non-game display state
 * cannot retain game control, so those transitions revoke it structurally.
 */
export function setViewportQuadrant(patch: { run?: RunMode; display?: DisplayMode; control?: ControlOwner }): void {
  const nextRun = patch.run ?? run;
  const nextDisplay = patch.display ?? display;
  const requestedControl = patch.control ?? control;
  const nextControl: ControlOwner = nextRun === 'play' && nextDisplay === 'game'
    ? requestedControl
    : 'editor';
  if (nextRun === run && nextDisplay === display && nextControl === control) return;
  run = nextRun;
  display = nextDisplay;
  control = nextControl;
  const snap = getViewportQuadrant();
  for (const fn of listeners) fn(snap);
}

/** Subscribe to quadrant changes; returns an unsubscribe. */
export function onViewportQuadrantChange(fn: QuadrantListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
