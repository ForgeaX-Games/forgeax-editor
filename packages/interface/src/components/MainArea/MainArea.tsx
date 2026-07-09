import { useShellStore } from '../../store';
import { ViewportPanel } from './SurfacePanels';
import { CenterPluginLayer } from './CenterPluginLayer';
import { usePanelRenderers } from '../DockShell/panelRenderers';
import './MainArea.css';

// 2026-05-17 — Bus mode tab + BusAdminPanel render here removed.
// Bus inventory is now a "Plugins" section inside SettingsPanel (overlay,
// opened via gear icon).  AppMode union still has 'bus' for backward compat
// with persisted store state — falls through to no render here.
// 2026-06-30: 'preview'/'edit' merged into single 'viewport' mode.
// 2026-07-08 (v9): Scene workbench mode id renamed 'edit' → 'scene'.
export function MainArea() {
  const mode = useShellStore((s) => s.mode);
  // MainArea body is a 前L2 @forgeax/ai-workbench app injected via the
  // slots.MainAreaBody slot (R4); interface holds no @forgeax/ai-workbench import.
  const MainAreaBody = usePanelRenderers().slots?.MainAreaBody;
  return (
    <main className="main-area">
      {mode === 'scene' && <ViewportPanel />}
      {mode === 'ai' && MainAreaBody && (
        <div data-fx-slot="MainAreaBody" style={{ display: 'contents' }}>
          <MainAreaBody />
        </div>
      )}
      {/* Always-mounted keep-alive overlay for standalone center plugins. Lives
          here (above the mode/tab conditionals) so plugin iframes survive
          viewport↔workbench and tab switches instead of cold-restarting. It
          self-hides when no standalone plugin is expanded. */}
      <CenterPluginLayer />
    </main>
  );
}
