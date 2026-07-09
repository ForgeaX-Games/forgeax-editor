// DockPanelHost — the sole consumer of PanelRenderers.panels, and the sole
// carrier of the `data-fx-slot="DockPanel:<id>"` structural marker.
//
// Any dockview panel body (chat, agents, hierarchy, assets, inspector, …) that
// wants to render its studio-injected content mounts <DockPanelHost id={id}/>.
// The host looks the id up in the panels registry, renders the body, and
// wraps it in a structural marker so the slot debug overlay can trace the
// container → body relationship.
//
// When no body is registered, renders a neutral "Panel not mounted" placeholder
// so the DockShell layout stays valid and the debug overlay still shows the
// empty slot.
import type { ReactNode } from 'react';
import { usePanelRenderers } from './panelRenderers';

export function DockPanelHost({ id }: { id: string }): ReactNode {
  const { panels } = usePanelRenderers();
  const body = panels?.[id]?.render();
  return (
    <div data-fx-slot={`DockPanel:${id}`} style={{ display: 'contents' }}>
      {body ?? (
        <div className="surface-placeholder" data-panel={id} data-panel-unmounted="1">
          <div className="surface-placeholder-title">Panel not mounted</div>
        </div>
      )}
    </div>
  );
}
