import { useSyncExternalStore } from 'react';
import type { CommandError, EditorOp } from '../types';
import { registerApplier } from '../io/appliers';
import type { SelectedAsset } from './asset-selection';

export interface EditorPageNavigation {
  openAsset(asset: SelectedAsset): Promise<void>;
  getActiveAsset(): SelectedAsset | null;
  subscribe(listener: () => void): () => void;
}

const inert: EditorPageNavigation = {
  async openAsset() {
    throw new Error('editor Page navigation is not configured by the host');
  },
  getActiveAsset: () => null,
  subscribe: () => () => {},
};

// A stack of registrations, not a single slot. React StrictMode, Vite HMR and a
// studio game switch all boot two AppHosts whose async `setup()` phases overlap,
// and the discarded host can finish setup AFTER the surviving one. With a single
// slot the stale host overwrites the live registration and its own teardown then
// leaves `inert` behind, so every later openAssetEditor throws for the rest of
// the session. Each registration removes only its own entry, so whoever else is
// still registered stays reachable.
const registrations: EditorPageNavigation[] = [];
const listeners = new Set<() => void>();
let detachUpstream: (() => void) | null = null;

function activeNavigation(): EditorPageNavigation {
  return registrations[registrations.length - 1] ?? inert;
}

/** Re-point the fan-out at the newest registration and wake every reader. This
 *  also covers panels that mounted before any host registered: they subscribe to
 *  the stable fan-out, never to `inert.subscribe`'s dead no-op. */
function rebind(): void {
  detachUpstream?.();
  const notify = (): void => { for (const listener of [...listeners]) listener(); };
  detachUpstream = activeNavigation().subscribe(notify);
  notify();
}

export function configureEditorPageNavigation(next: EditorPageNavigation | null): () => void {
  if (next === null) return () => {};
  registrations.push(next);
  rebind();
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const at = registrations.lastIndexOf(next);
    if (at >= 0) registrations.splice(at, 1);
    rebind();
  };
}

export function getActiveEditorAsset(): SelectedAsset | null {
  return activeNavigation().getActiveAsset();
}

/** Execute the shell-owned page effect without promoting shell chrome to Runtime authority. */
export function openEditorAssetPage(asset: SelectedAsset): Promise<void> {
  return activeNavigation().openAsset(asset);
}

function subscribeActiveEditorAsset(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useActiveEditorAsset(): SelectedAsset | null {
  return useSyncExternalStore(subscribeActiveEditorAsset, getActiveEditorAsset, getActiveEditorAsset);
}

registerApplier('session', 'openAssetEditor', (op: EditorOp) => {
  const asset = (op as { asset: SelectedAsset }).asset;
  if (registrations.length === 0) {
    const error: CommandError = {
      code: 'page-navigation-unavailable',
      hint: 'This host installs no editor page navigation, so the asset editor cannot be opened.',
      retryable: false,
    };
    return { ok: false, error };
  }
  // openAssetEditor is not request-correlated, so the gateway drops `completion`.
  // Terminating the rejection here is what keeps a failed page open a logged
  // failure instead of an unhandled rejection painted as a red error overlay;
  // the promise is still returned so a correlated caller can await it.
  const completion = activeNavigation().openAsset(asset);
  completion.catch((cause: unknown) => {
    console.error('[editor-core] openAssetEditor: the host failed to open the asset page', cause);
  });
  return { ok: true, completion };
});
