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

// ViewportPanel — combined edit+preview surface, renders the editor viewport anchor.
// The keep-alive layer manages the actual surface rendering.
export function ViewportPanel(_props: { viewportOnly?: boolean } = {}) {
  return (
    <div className="surface-region">
      <SurfaceAnchor kind="edit" />
    </div>
  );
}

// Backward-compat aliases kept for existing consumers during migration.
// These are thin wrappers around ViewportPanel; the old 'preview'/'edit' modes
// should no longer be used (they map to 'viewport' via AppMode migration).
export { ViewportPanel as EditPanel };
export function PreviewPanel() {
  return (
    <div className="surface-region">
      <SurfaceAnchor kind="play" />
    </div>
  );
}
