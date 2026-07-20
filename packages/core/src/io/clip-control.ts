// @forgeax/editor-core — viewport animation clip transport + one-shot view intents.
//
// Generic (scene-editor-wide) preview controls, extracted from the former socket
// editor. Two channels, both cross-window-bridged by store.ts so a popped-out
// panel can drive the MAIN viewport where the preview AnimationPlayer lives:
//
//   clip transport:  play/pause + speed + scrub-phase for the preview character's
//                     AnimationPlayer (pose calibration; pause any frame).
//   view intents:    fire-and-forget viewport commands (reset camera / recenter).
//
// Flow (popout → main):
//   UI → setClipControl → (local listeners) + (forwarder, popout only)
//                                              → BroadcastChannel → main
//   main mainOnMessage → setClipControl(remote) → (local listeners) → viewport
// store.ts owns the channel and injects the forwarder + applies inbound msgs,
// keeping this module channel-agnostic (no dep cycle into store.ts).

import { useSyncExternalStore } from 'react';

// ── Clip scrubber (animation preview transport) ──

/** Preview animation transport state. `phase` is normalized 0..1. */
export interface ClipControl {
  paused: boolean;
  speed: number;
  phase: number;
  /** True when the last change was a scrub-seek (vs a pause/speed-only change). */
  applyPhase: boolean;
}

let clipControl: ClipControl = { paused: false, speed: 1, phase: 0, applyPhase: false };
let clipVersion = 0;
const clipListeners = new Set<() => void>();
let clipForwarder: ((c: ClipControl) => void) | null = null;

export function getClipControl(): ClipControl {
  return clipControl;
}

export function getClipControlVersion(): number {
  return clipVersion;
}

/** Inject the cross-window forwarder (store.ts wires this in popout windows). */
export function setClipControlForwarder(fn: ((c: ClipControl) => void) | null): void {
  clipForwarder = fn;
}

/**
 * Update the preview transport. `opts.remote` marks an inbound cross-window
 * message so it is applied locally but NOT re-forwarded (no echo loop).
 */
export function setClipControl(patch: Partial<ClipControl>, opts?: { remote?: boolean }): void {
  clipControl = { ...clipControl, ...patch };
  clipVersion++;
  for (const fn of clipListeners) fn();
  if (!opts?.remote && clipForwarder) clipForwarder(clipControl);
}

/** Viewport (main) subscribes to apply transport changes to the AnimationPlayer. */
export function onClipControl(fn: () => void): () => void {
  clipListeners.add(fn);
  return () => clipListeners.delete(fn);
}

export function useClipControl(): ClipControl {
  useSyncExternalStore(
    (fn) => { clipListeners.add(fn); return () => clipListeners.delete(fn); },
    getClipControlVersion,
    getClipControlVersion,
  );
  return clipControl;
}

// ── One-shot viewport intents (reset camera / recenter preview character) ──
// Fire-and-forget events (not persistent state): a panel requests, the main
// viewport acts. Same cross-window bridge shape as the clip scrubber.

export type ViewCmd = 'resetCamera' | 'recenter';

const viewListeners = new Set<(cmd: ViewCmd) => void>();
let viewForwarder: ((cmd: ViewCmd) => void) | null = null;

/** Inject the cross-window forwarder (store.ts wires this in popout windows). */
export function setViewRequestForwarder(fn: ((cmd: ViewCmd) => void) | null): void {
  viewForwarder = fn;
}

/** Main viewport subscribes to act on viewport intents. */
export function onViewRequest(fn: (cmd: ViewCmd) => void): () => void {
  viewListeners.add(fn);
  return () => viewListeners.delete(fn);
}

/** Request a one-shot viewport intent. `opts.remote` = inbound (don't re-forward). */
export function requestView(cmd: ViewCmd, opts?: { remote?: boolean }): void {
  for (const fn of viewListeners) fn(cmd);
  if (!opts?.remote && viewForwarder) viewForwarder(cmd);
}
