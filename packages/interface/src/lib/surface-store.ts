/**
 * Phase D2 — surface store.
 *
 * In-process registry of `surface.expose` snapshots that arrive from plugin
 * iframes via the host SDK (`port.surface.subscribe` in StandaloneExtensionIframe).
 * Lets the dev-mode hover overlay show "this button equals tool X(args)" and
 * gives an AI prompt-builder a single place to read the catalogue of UI
 * actions the user could currently click.
 *
 * Scope intentionally narrow: a Map keyed on `extensionId:surfaceId`, plus a
 * subscribe(cb) fanout. No persistence, no server round-trip — a refresh
 * tears it down and the next iframe load re-emits expose().
 */

export interface SurfaceAction {
  id: string;
  label?: string;
  args?: unknown;
  enabled: boolean;
  hotkey?: string;
}

export interface SurfaceState {
  extensionId: string;
  surfaceId: string;
  actions: SurfaceAction[];
  snapshot: unknown;
  /** Wall-clock ms when this surface was last refreshed by the plugin. */
  updatedAt: number;
}

type Listener = (snapshot: ReadonlyMap<string, SurfaceState>) => void;

const surfaces = new Map<string, SurfaceState>();
const listeners = new Set<Listener>();

function key(extensionId: string, surfaceId: string): string {
  return `${extensionId}:${surfaceId}`;
}

function fanout(): void {
  for (const cb of listeners) {
    try {
      cb(surfaces);
    } catch (e) {
      if (typeof console !== 'undefined') console.error('[surface-store] listener', e);
    }
  }
}

export function upsertSurface(s: SurfaceState): void {
  surfaces.set(key(s.extensionId, s.surfaceId), { ...s, updatedAt: Date.now() });
  fanout();
}

/** Drop every surface owned by `extensionId`. Call when an iframe unmounts. */
export function removeExtensionSurfaces(extensionId: string): void {
  let changed = false;
  for (const k of [...surfaces.keys()]) {
    if (surfaces.get(k)!.extensionId === extensionId) {
      surfaces.delete(k);
      changed = true;
    }
  }
  if (changed) fanout();
}

export function listSurfaces(): SurfaceState[] {
  return [...surfaces.values()];
}

export function getSurface(extensionId: string, surfaceId: string): SurfaceState | null {
  return surfaces.get(key(extensionId, surfaceId)) ?? null;
}

export function subscribeSurfaces(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Test helper. */
export function _resetSurfaceStoreForTests(): void {
  surfaces.clear();
  listeners.clear();
}
