// Surface anchor registry — the bridge between the dockview `preview`/`edit`
// panels and the always-mounted SurfaceKeepAliveLayer.
//
// Why this exists: Play / Edit / AI are separate dockview *workspaces*. Switching
// tabs rebuilds the whole dock tree (DockShell `api.fromJSON`/`clear+buildDefault`),
// which would destroy + cold-reboot the heavy Play/Edit viewport iframes on every
// switch (the freeze). To keep those iframes ALIVE we mount them ONCE in a stable
// parent outside dockview (SurfaceKeepAliveLayer) and position each one over the
// place where its dockview panel currently sits. The dockview panel renders only a
// thin `<SurfaceAnchor>` placeholder that publishes its DOM element here; the layer
// reads the active anchor's rect and overlays the live surface on top.
//
// Same "render-but-hide, never re-parent" idea as KeepAliveExtensionIframes — moving an
// iframe between DOM parents forces a reload, so the iframe never moves; only its
// fixed-position rect tracks the anchor.

export type SurfaceKind = 'play' | 'edit';

type AnchorListener = () => void;

const anchors = new Map<SurfaceKind, HTMLElement>();
const anchorListeners = new Set<AnchorListener>();
const relayoutListeners = new Set<AnchorListener>();

function notifyAnchors(): void {
  for (const cb of anchorListeners) {
    try { cb(); } catch (e) { if (typeof console !== 'undefined') console.error('[surfaceAnchors] listener', e); }
  }
}

/** Register (el) / unregister (null) the DOM node that marks where `kind`'s
 *  surface should be drawn. Call from the dockview panel's mount/unmount. */
export function setAnchor(kind: SurfaceKind, el: HTMLElement | null): void {
  if (el) {
    if (anchors.get(kind) === el) return;
    anchors.set(kind, el);
  } else {
    if (!anchors.has(kind)) return;
    anchors.delete(kind);
  }
  notifyAnchors();
}

export function getAnchor(kind: SurfaceKind): HTMLElement | null {
  return anchors.get(kind) ?? null;
}

/** Fires whenever an anchor is added/removed (panel mount/unmount, workspace
 *  switch, pop-out). The keep-alive layer re-evaluates which surface is visible. */
export function subscribeAnchors(cb: AnchorListener): () => void {
  anchorListeners.add(cb);
  return () => { anchorListeners.delete(cb); };
}

/** Pure position/size invalidation — anchor identity unchanged but its rect may
 *  have moved (dock drag/resize/close). DockShell pings this on layout change. */
export function pingAnchorRelayout(): void {
  for (const cb of relayoutListeners) {
    try { cb(); } catch (e) { if (typeof console !== 'undefined') console.error('[surfaceAnchors] relayout', e); }
  }
}

export function subscribeRelayout(cb: AnchorListener): () => void {
  relayoutListeners.add(cb);
  return () => { relayoutListeners.delete(cb); };
}

/** Test helper. */
export function _resetSurfaceAnchorsForTests(): void {
  anchors.clear();
  anchorListeners.clear();
  relayoutListeners.clear();
}
