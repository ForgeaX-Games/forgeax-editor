// vfx-emitter-mask — shared emitter-visibility intent for a VFX effect.
//
// The System Outline tree (this package) writes it via per-emitter eye toggles,
// exactly like the scene Hierarchy hides entities. The VFX preview viewport
// (edit-runtime, which depends on this package) subscribes and dispatches the
// Runtime-owned setEmitterMask operation whenever the intent changes. Keeping
// the store here — the LOWER package — is what lets the header-free control live
// in the tree without edit-runtime ever importing panels' UI.
//
// State is a set of HIDDEN emitter ids scoped to one asset guid; switching the
// active asset resets it (a fresh effect starts fully visible).

import { useSyncExternalStore } from 'react';

const EMPTY: ReadonlySet<string> = new Set();

interface VfxEmitterMaskSnapshot {
  readonly assetGuid: string;
  readonly hidden: ReadonlySet<string>;
}

let activeAssetGuid = '';
let hidden = new Set<string>();
let snapshot: VfxEmitterMaskSnapshot = { assetGuid: '', hidden: EMPTY };
const listeners = new Set<() => void>();

function rebuild(): void {
  snapshot = { assetGuid: activeAssetGuid, hidden: new Set(hidden) };
}

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** Point the mask at `assetGuid` and clear it (the preview viewport calls this
 *  when a new effect boots). No-op when the asset is already active and empty. */
export function resetVfxEmitterMask(assetGuid: string): void {
  if (activeAssetGuid === assetGuid && hidden.size === 0) return;
  activeAssetGuid = assetGuid;
  hidden = new Set();
  rebuild();
  emit();
}

/** Flip one emitter's hidden state; re-targets the store if the asset changed. */
export function toggleVfxEmitterHidden(assetGuid: string, emitterId: string): void {
  if (assetGuid !== activeAssetGuid) {
    activeAssetGuid = assetGuid;
    hidden = new Set();
  }
  if (hidden.has(emitterId)) hidden.delete(emitterId);
  else hidden.add(emitterId);
  rebuild();
  emit();
}

export function getVfxEmitterMaskSnapshot(): VfxEmitterMaskSnapshot {
  return snapshot;
}

export function subscribeVfxEmitterMask(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Hidden emitter ids for `assetGuid` (empty for any other asset). */
export function getHiddenVfxEmitters(assetGuid: string): ReadonlySet<string> {
  return snapshot.assetGuid === assetGuid ? snapshot.hidden : EMPTY;
}

/** Reactive hidden-emitter set for the tree rows. */
export function useHiddenVfxEmitters(assetGuid: string): ReadonlySet<string> {
  const snap = useSyncExternalStore(
    subscribeVfxEmitterMask,
    getVfxEmitterMaskSnapshot,
    getVfxEmitterMaskSnapshot,
  );
  return snap.assetGuid === assetGuid ? snap.hidden : EMPTY;
}

/** The visible subset of `emitterIds` under the current mask for `assetGuid`. */
export function resolveEnabledVfxEmitters(
  assetGuid: string,
  emitterIds: readonly string[],
): string[] {
  const hiddenSet = getHiddenVfxEmitters(assetGuid);
  return emitterIds.filter((id) => !hiddenSet.has(id));
}
