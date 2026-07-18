// Display visibility bus — unified switch for auxiliary entity visibility
// (feat-20260630-viewport M5 / w23, requirements AC-04, plan-strategy D-5).
//
// Research Finding 6: gizmo/grid/icons/skylight each spawn independently with
// no unified display switch. The display bus is the SSOT for display-mode-driven
// visibility — every auxiliary entity producer subscribes to the bus and toggles
// its entities' visibility on display change without a cross-cutting despawn API.
//
// display='game': auxiliary entities hide (clean view, AC-04)
// display='scene': auxiliary entities show (editing aids on)
//
// Engine layer stays neutral (OOS-2, OOS-4): the bus lives in edit-runtime and
// controls entity visibility through spawn/despawn or component mutations — it
// never touches the engine render pipeline.
//
// WIRING: call `syncDisplayBusToQuadrant()` once after the viewport-quadrant module
// is fully initialized (typically from main.tsx). The bus does NOT auto-import the
// quadrant module at module top-level — that would create a TDZ circular init
// dependency (viewport-quadrant variables aren't live yet when display-bus loads).

import type { DisplayMode } from './viewport';

export type { DisplayMode };

type DisplayChangeListener = (display: DisplayMode) => void;
const listeners = new Set<DisplayChangeListener>();

let currentDisplay: DisplayMode = 'scene'; // default AC-03: edit·scene

/** Whether auxiliary entities should currently be visible (derived from display axis). */
export function isAuxVisible(): boolean {
  return currentDisplay !== 'game';
}

/** Current display mode from the SSOT. */
export function getDisplayMode(): DisplayMode {
  return currentDisplay;
}

/** Subscribe to display-mode changes. Returns an unsubscribe function. */
export function onDisplayModeChange(fn: DisplayChangeListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Internal setter — called ONLY by the quadrant sync bridge. Sets the current
 *  display and notifies subscribers. De-dupes: no-op if display unchanged. */
export function _syncDisplayMode(next: DisplayMode): void {
  if (next !== currentDisplay) {
    currentDisplay = next;
    for (const fn of listeners) fn(next);
  }
}