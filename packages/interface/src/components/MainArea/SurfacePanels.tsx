// SurfacePanels — agnostic wrappers around the injected edit / preview
// surfaces. These keep interface free of any `@forgeax/editor*` import: the
// real surfaces are provided by the host (studio) through PanelRenderers
// context; interface alone renders neutral placeholders.
//
// Consumed by panelRegistry (dockview 'edit'/'preview' panels), MainArea
// (mode tabs) and DetachedSurface (popped-out OS windows) — all three used
// to import EditMode/PreviewMode directly; now they go through context.
import { usePanelRenderers } from '../DockShell/panelRenderers';

export function EditPanel({ viewportOnly }: { viewportOnly?: boolean } = {}) {
  const { renderEdit } = usePanelRenderers();
  if (!renderEdit) {
    return (
      <div className="surface-placeholder surface-placeholder--edit">
        <div className="surface-placeholder-title">No editor configured</div>
      </div>
    );
  }
  return <>{renderEdit({ viewportOnly })}</>;
}

export function PreviewPanel() {
  const { renderPreview } = usePanelRenderers();
  if (!renderPreview) {
    return (
      <div className="surface-placeholder surface-placeholder--preview">
        <div className="surface-placeholder-title">No preview configured</div>
      </div>
    );
  }
  return <>{renderPreview()}</>;
}
