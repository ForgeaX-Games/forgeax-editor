// store/doc-version — the re-render version counter bumped on every bus change.
//
// State: `docVersion` (let) + `docListeners` (Set), both PRIVATE to this module.
// Consumers: panels re-read the doc via useDocVersion; scene-persistence and
// disk-watch signal a direct (non-bus) mutation by CALLING the public
// notifyDocChanged() — they never touch docVersion/docListeners directly, so no
// internal seam is exported here.
//
// R3 (plan-strategy §4 / research F-4): the top-level `bus.subscribe(...)` below
// is an EVAL-TIME side effect and MUST stay a top-level statement (executed once
// when this module is evaluated) — NOT lazified — or docVersion tracking breaks.
// ESM guarantees ./bus evaluates first, so `bus` is a live singleton here.
//
// Anchors:
//   plan-strategy §2 D-2: cluster 9 (store.ts:289-312)
//   plan-strategy §4 R3 / research F-4: bus.subscribe kept top-level.
//   requirements AC-09: pure structural migration.
import { useSyncExternalStore } from 'react';
import { bus } from './bus';
import type { EditorCommand } from '../types';

// Re-render hook: bumps a version on every bus change so panels re-read doc.
let docVersion = 0;
const docListeners = new Set<() => void>();
bus.subscribe(() => {
  docVersion++;
  for (const fn of docListeners) fn();
});
function subscribeDoc(fn: () => void): () => void {
  docListeners.add(fn);
  return () => docListeners.delete(fn);
}
/** Bump docVersion + fire listeners so panels re-read the doc after a direct
 *  (non-bus) world mutation — e.g. a nested GLB SceneInstance added by
 *  instantiateSceneRefUnderWorld, which the bus never sees. */
export function notifyDocChanged(): void {
  docVersion++;
  for (const fn of docListeners) fn();
}
export function useDocVersion(): number {
  return useSyncExternalStore(subscribeDoc, () => docVersion, () => docVersion);
}

export function dispatch(cmd: EditorCommand): void {
  bus.dispatch(cmd);
}
