// @forgeax/editor-core — Socket (绑点) editor transient + working state.
//
// The SocketDoc is the working document for the Socket editor (separate from the
// scene EditSession; persisted as `*.socket.json`). This module holds it plus the
// transient view state (selected socket id, editing coordinate space, pivot) using
// the same module-state + listener + useSyncExternalStore pattern as store.ts.
//
// NOTE (开发文档 §7.3): full bus-style undo/redo for socket edits is deferred to
// M3. M1 keeps a single working doc with direct mutators + a version counter that
// drives React re-renders and viewport preview.

import { useSyncExternalStore } from 'react';
import { emptySocketDoc, type SocketDef, type SocketDoc } from './socket';

/** Editing coordinate space — affects gizmo handling only, never exported values. */
export type SocketCoordSpace = 'boneLocal' | 'worldAligned';
/** Editing pivot — affects gizmo rotation/scale center only, never exported values. */
export type SocketPivot = 'geomCenter' | 'socketPoint';

// ── Working document ──

let socketDoc: SocketDoc = emptySocketDoc();
let docVersion = 0;
const docListeners = new Set<() => void>();

function emitDoc(): void {
  docVersion++;
  for (const fn of docListeners) fn();
}

export function getSocketDoc(): SocketDoc {
  return socketDoc;
}

/** Replace the entire working document (e.g. after import / load). */
export function setSocketDoc(doc: SocketDoc): void {
  socketDoc = doc;
  // Keep selection valid against the new doc.
  if (selectedSocketId !== null && !doc.sockets.some((s) => s.id === selectedSocketId)) {
    selectedSocketId = doc.sockets[0]?.id ?? null;
    emitSelection();
  }
  emitDoc();
}

/** Monotonic version; subscribe via {@link useSocketDocVersion} to re-render. */
export function getSocketDocVersion(): number {
  return docVersion;
}

function subscribeDoc(fn: () => void): () => void {
  docListeners.add(fn);
  return () => docListeners.delete(fn);
}

export function useSocketDocVersion(): number {
  return useSyncExternalStore(subscribeDoc, getSocketDocVersion, getSocketDocVersion);
}

// ── Mutators (operate on the working doc) ──

export function addSocket(def: SocketDef): void {
  socketDoc = { ...socketDoc, sockets: [...socketDoc.sockets, def] };
  setSelectedSocketId(def.id);
  emitDoc();
}

export function removeSocket(id: string): void {
  socketDoc = { ...socketDoc, sockets: socketDoc.sockets.filter((s) => s.id !== id) };
  if (selectedSocketId === id) setSelectedSocketId(socketDoc.sockets[0]?.id ?? null);
  emitDoc();
}

/** Shallow-merge a patch into the socket with `id`. */
export function updateSocket(id: string, patch: Partial<SocketDef>): void {
  socketDoc = {
    ...socketDoc,
    sockets: socketDoc.sockets.map((s) => (s.id === id ? { ...s, ...patch } : s)),
  };
  emitDoc();
}

export function setSkeletonId(skeletonId: string): void {
  socketDoc = { ...socketDoc, skeletonId };
  emitDoc();
}

// ── Selection ──

let selectedSocketId: string | null = null;
const selectionListeners = new Set<() => void>();

function emitSelection(): void {
  for (const fn of selectionListeners) fn();
}

export function getSelectedSocketId(): string | null {
  return selectedSocketId;
}

export function setSelectedSocketId(id: string | null): void {
  if (selectedSocketId === id) return;
  selectedSocketId = id;
  emitSelection();
}

export function useSelectedSocketId(): string | null {
  return useSyncExternalStore(
    (fn) => { selectionListeners.add(fn); return () => selectionListeners.delete(fn); },
    getSelectedSocketId,
    getSelectedSocketId,
  );
}

// ── Editing modes (coord space / pivot) ──

let coordSpace: SocketCoordSpace = 'boneLocal';
let pivot: SocketPivot = 'geomCenter';
const modeListeners = new Set<() => void>();

function emitMode(): void {
  for (const fn of modeListeners) fn();
}

export function getCoordSpace(): SocketCoordSpace {
  return coordSpace;
}
export function setCoordSpace(space: SocketCoordSpace): void {
  if (coordSpace === space) return;
  coordSpace = space;
  emitMode();
}
export function useCoordSpace(): SocketCoordSpace {
  return useSyncExternalStore(
    (fn) => { modeListeners.add(fn); return () => modeListeners.delete(fn); },
    getCoordSpace,
    getCoordSpace,
  );
}

export function getPivot(): SocketPivot {
  return pivot;
}
export function setPivot(p: SocketPivot): void {
  if (pivot === p) return;
  pivot = p;
  emitMode();
}
export function usePivot(): SocketPivot {
  return useSyncExternalStore(
    (fn) => { modeListeners.add(fn); return () => modeListeners.delete(fn); },
    getPivot,
    getPivot,
  );
}

// ── Live preview signal (viewport subscribes; mirrors store.onAnimPreview) ──

const previewListeners = new Set<() => void>();

/** Fire after any working-doc change so the viewport re-applies sockets live. */
export function onSocketPreview(fn: () => void): () => void {
  previewListeners.add(fn);
  return () => previewListeners.delete(fn);
}

// Bridge doc changes to the preview channel.
subscribeDoc(() => {
  for (const fn of previewListeners) fn();
});

// ── Clip scrubber (animation preview control; cross-window via store.ts) ──
//
// The socket editor pauses/plays/scrubs the preview character's animation to
// calibrate the prop across poses (开发文档 §9). The panel may be docked in the
// main window OR popped out into its own document — so the AnimationPlayer it
// controls lives in a DIFFERENT JS context. The flow:
//   panel → setClipControl → (local listeners) + (forwarder, popout only)
//                                                   → BroadcastChannel → main
//   main mainOnMessage → setClipControl(remote) → (local listeners) → viewport
// store.ts owns the channel and injects the forwarder + applies inbound msgs,
// keeping this module channel-agnostic (no dep cycle into store.ts).

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

// ── One-shot viewport intents (reset camera / recenter character; 需求 §4.1) ──
// Fire-and-forget events (not persistent state): the panel requests, the main
// viewport acts. Same cross-window bridge shape as the clip scrubber.

export type SocketViewCmd = 'resetCamera' | 'recenter';

const viewListeners = new Set<(cmd: SocketViewCmd) => void>();
let viewForwarder: ((cmd: SocketViewCmd) => void) | null = null;

/** Inject the cross-window forwarder (store.ts wires this in popout windows). */
export function setViewRequestForwarder(fn: ((cmd: SocketViewCmd) => void) | null): void {
  viewForwarder = fn;
}

/** Main viewport subscribes to act on viewport intents. */
export function onViewRequest(fn: (cmd: SocketViewCmd) => void): () => void {
  viewListeners.add(fn);
  return () => viewListeners.delete(fn);
}

/** Request a one-shot viewport intent. `opts.remote` = inbound (don't re-forward). */
export function requestView(cmd: SocketViewCmd, opts?: { remote?: boolean }): void {
  for (const fn of viewListeners) fn(cmd);
  if (!opts?.remote && viewForwarder) viewForwarder(cmd);
}
