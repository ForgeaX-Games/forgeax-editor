// store/doc-version — the re-render version counter bumped on every gateway change.
//
// State: `docVersion` (let) + `docListeners` (Set), both PRIVATE to this module.
// Consumers: panels re-read the doc via useDocVersion; scene-persistence and
// disk-watch signal a direct (non-gateway) mutation by CALLING the public
// notifyDocChanged() — they never touch docVersion/docListeners directly, so no
// internal seam is exported here.
//
// R3 (plan-strategy §4 / research F-4): the top-level `gateway.subscribe(...)` below
// is an EVAL-TIME side effect and MUST stay a top-level statement (executed once
// when this module is evaluated) — NOT lazified — or docVersion tracking breaks.
// ESM guarantees ./gateway evaluates first, so `gateway` is a live singleton here.
//
// Anchors:
//   plan-strategy §2 D-2: cluster 9 (store.ts:289-312)
//   plan-strategy §4 R3 / research F-4: gateway.subscribe kept top-level.
//   requirements AC-09: pure structural migration.
import { useSyncExternalStore } from 'react';
import { gateway } from './gateway';

// Re-render hook: bumps a version on every gateway change so panels re-read doc.
let docVersion = 0;
const docListeners = new Set<() => void>();
gateway.subscribe(() => {
  docVersion++;
  for (const fn of docListeners) fn();
});
function subscribeDoc(fn: () => void): () => void {
  docListeners.add(fn);
  return () => docListeners.delete(fn);
}
/** Bump docVersion + fire listeners so panels re-read the doc after a direct
 *  (non-gateway) world mutation — e.g. a nested GLB SceneInstance added by
 *  instantiateSceneRefUnderWorld, which the gateway never sees. */
export function notifyDocChanged(): void {
  docVersion++;
  for (const fn of docListeners) fn();
}
export function useDocVersion(): number {
  return useSyncExternalStore(subscribeDoc, () => docVersion, () => docVersion);
}

// M3 (plan-strategy §2 D-6): the origin-less `dispatch` wrapper is DELETED, not
// kept — a second dispatch symbol = a double track (AC-08 mandates no compat
// layer). All callers (UI + core/session/ops.ts) now call gateway.dispatch(op)
// directly, where origin defaults to 'human' and the AI passes 'ai' explicitly.
