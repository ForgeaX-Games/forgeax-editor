// SurfacePanels — the dockview `preview` / `edit` panel bodies.
//
// These USED to render the real injected edit/preview surfaces. They no longer do:
// because Play / Edit are separate dockview workspaces, switching tabs rebuilds the
// dock tree and would destroy + cold-reboot the heavy viewport iframes on every
// switch (the Play↔Edit freeze). Instead the real surfaces are mounted ONCE in the
// always-mounted SurfaceKeepAliveLayer (sibling of DockShell) and kept alive across
// switches. Here each panel renders only a thin <SurfaceAnchor> placeholder that
// publishes its DOM rect via lib/surfaceAnchors; the keep-alive layer overlays the
// live surface on top of the active anchor. This keeps interface free of any
// `@forgeax/editor*` import (the surfaces come from PanelRenderers context, consumed
// by the layer).
//
// The FatalBanner (reason + Reload) is rendered by the keep-alive layer on top of
// the live surface — NOT here — because the fixed live surface overlays this anchor,
// which would hide a banner placed underneath it.
import { useEffect, useRef } from 'react';
import { setAnchor, type SurfaceKind } from '../../lib/surfaceAnchors';

// SurfaceAnchor — empty flex-fill placeholder that registers its element with the
// anchor registry on mount and clears it on unmount. The keep-alive layer reads
// this element's bounding rect to position the live (kept-alive) surface over it.
function SurfaceAnchor({ kind }: { kind: SurfaceKind }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setAnchor(kind, ref.current);
    return () => setAnchor(kind, null);
  }, [kind]);
  return <div ref={ref} className="surface-anchor" data-surface-anchor={kind} />;
}

export function EditPanel(_props: { viewportOnly?: boolean } = {}) {
  // `viewportOnly` is now owned by the keep-alive layer's renderEdit() call; the
  // anchor only reserves space. Kept in the signature for call-site compatibility.
  return (
    <div className="surface-region">
      <SurfaceAnchor kind="edit" />
    </div>
  );
}

export function PreviewPanel() {
  return (
    <div className="surface-region">
      <SurfaceAnchor kind="play" />
    </div>
  );
}
