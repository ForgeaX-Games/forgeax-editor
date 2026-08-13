// FPS store — lightweight holder for the live frames-per-second value reported
// by the frame-loop accumulator. The PanelShell viewport toolbar reads this to
// display the live FPS counter outside the render surface.
//
// This is the sole SSOT for the editor's FPS readout.

type FpsListener = (fps: number) => void;
const listeners = new Set<FpsListener>();
let currentFps = 0;

/** Current frames-per-second value from the last 1-second sampling window. */
export function getFps(): number {
  return currentFps;
}

/** Set the FPS value (called by the frame-loop accumulator). No-ops if unchanged. */
export function setFps(fps: number): void {
  if (fps !== currentFps) {
    currentFps = fps;
    for (const fn of listeners) fn(fps);
  }
}

/** Subscribe to FPS updates. Returns an unsubscribe function. */
export function onFpsChange(fn: FpsListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}