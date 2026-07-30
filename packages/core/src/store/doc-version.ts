// store/doc-version — authored document invalidation only.
//
// State: `docVersion` (let) + `docListeners` (Set), both PRIVATE to this module.
// Consumers: authored panels re-read the document via useDocVersion;
// scene-persistence and disk-watch signal direct authored mutations by calling
// the public notifyDocChanged() entry. Runtime World frames never call this
// module.
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

type RuntimeUiTestGate = { disableRuntimeUiPulse?: boolean };
function runtimeUiPulseEnabled(): boolean {
  return (globalThis as typeof globalThis & { __forgeaxRuntimeUiTestGate?: RuntimeUiTestGate })
    .__forgeaxRuntimeUiTestGate?.disableRuntimeUiPulse !== true;
}

// Re-render hook: bumps a version on authored gateway commands so panels can
// re-read the authored document.
let docVersion = 0;
const docListeners = new Set<() => void>();
let authoredVersion = 0;
const authoredListeners = new Set<() => void>();
gateway.subscribe((_doc, command) => {
  if (!runtimeUiPulseEnabled() || command === null) return;
  docVersion++;
  for (const fn of docListeners) fn();
});
gateway.subscribe((_doc, command) => {
  if (!runtimeUiPulseEnabled() || command === null) return;
  authoredVersion++;
  for (const fn of authoredListeners) fn();
});
function subscribeDoc(fn: () => void): () => void {
  docListeners.add(fn);
  return () => docListeners.delete(fn);
}
/** Authored document subscription. Consumers may pair it with a value-compared
 *  snapshot, but runtime World frames do not notify this signal. */
export function subscribeDocVersion(fn: () => void): () => void {
  return subscribeDoc(fn);
}
/** Notify authored-side consumers after a direct producer mutation that is not
 *  represented by a gateway command, such as a scene asset instantiation. */
export function notifyDocChanged(): void {
  if (!runtimeUiPulseEnabled()) return;
  docVersion++;
  for (const fn of docListeners) fn();
}
export function notifyAuthoredChanged(): void {
  authoredVersion++;
  for (const fn of authoredListeners) fn();
}
export function getAuthoredVersion(): number { return authoredVersion; }
export function subscribeAuthoredChanges(fn: () => void): () => void {
  authoredListeners.add(fn);
  return () => authoredListeners.delete(fn);
}
export function useAuthoredVersion(): number {
  return useSyncExternalStore(subscribeAuthoredChanges, getAuthoredVersion, getAuthoredVersion);
}
export function useDocVersion(): number {
  return useSyncExternalStore(subscribeDoc, () => docVersion, () => docVersion);
}

// M3 (plan-strategy §2 D-6): the origin-less `dispatch` wrapper is DELETED, not
// kept — a second dispatch symbol = a double track (AC-08 mandates no compat
// layer). All callers (UI + core/session/ops.ts) now call gateway.dispatch(op)
// directly, where origin defaults to 'human' and the AI passes 'ai' explicitly.
