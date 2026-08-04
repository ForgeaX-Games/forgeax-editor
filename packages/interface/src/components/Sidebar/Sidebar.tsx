import { usePanelRenderers } from '../DockShell/panelRenderers';

/** Generic shell tools panel. Page launchers live exclusively in ActivityRail;
 * this panel only hosts the application-supplied agents/tools body. */
export function Sidebar() {
  const SidebarAgents = usePanelRenderers().slots?.SidebarAgents;
  return (
    <aside className="studio-sidebar" data-fx-slot="Sidebar">
      {SidebarAgents ? <SidebarAgents /> : null}
    </aside>
  );
}
