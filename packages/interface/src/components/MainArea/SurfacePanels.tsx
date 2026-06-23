// SurfacePanels — agnostic wrappers around the injected edit / preview
// surfaces. These keep interface free of any `@forgeax/editor*` import: the
// real surfaces are provided by the host (studio) through PanelRenderers
// context; interface alone renders neutral placeholders.
//
// Consumed by panelRegistry (dockview 'edit'/'preview' panels), MainArea
// (mode tabs) and DetachedSurface (popped-out OS windows) — all three used
// to import EditMode/PreviewMode directly; now they go through context.
//
// Each wrapper also overlays the region's FatalBanner (reason + Reload) when
// the engine reports a region-fatal failure, so the user isn't left staring at
// a black viewport. The banner is absolutely positioned, so the wrapper is the
// positioning context (`.surface-region` → position: relative).
import { usePanelRenderers } from '../DockShell/panelRenderers';
import { FatalBanner } from '../StatusBar/FatalBanner';

export function EditPanel({ viewportOnly }: { viewportOnly?: boolean } = {}) {
  const { renderEdit } = usePanelRenderers();
  if (!renderEdit) {
    return (
      <div className="surface-placeholder surface-placeholder--edit">
        <div className="surface-placeholder-title">No editor configured</div>
      </div>
    );
  }
  return (
    <div className="surface-region">
      <FatalBanner source="edit" />
      {renderEdit({ viewportOnly })}
    </div>
  );
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
  return (
    <div className="surface-region">
      <FatalBanner source="play" />
      {renderPreview()}
    </div>
  );
}
