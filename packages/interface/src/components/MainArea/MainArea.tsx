import { useAppStore } from '../../store';
import { ViewportPanel } from './SurfacePanels';
import { WorkbenchMode } from './WorkbenchMode';
import { CenterPluginLayer } from './CenterPluginLayer';
import './MainArea.css';

// 2026-05-17 — Bus mode tab + BusAdminPanel render here removed.
// Bus inventory is now a "Plugins" section inside SettingsPanel (overlay,
// opened via gear icon).  AppMode union still has 'bus' for backward compat
// with persisted store state — falls through to no render here.
// 2026-06-30: 'preview'/'edit' merged into single 'viewport' mode.
export function MainArea() {
  const mode = useAppStore((s) => s.mode);
  return (
    <main className="main-area">
      {mode === 'edit' && <ViewportPanel />}
      {mode === 'workbench' && <WorkbenchMode />}
      {/* Always-mounted keep-alive overlay for standalone center plugins. Lives
          here (above the mode/tab conditionals) so plugin iframes survive
          viewport↔workbench and tab switches instead of cold-restarting. It
          self-hides when no standalone plugin is expanded. */}
      <CenterPluginLayer />
    </main>
  );
}
