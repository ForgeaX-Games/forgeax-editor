import { useActiveWorkbench } from '../../lib/useWorkbench';
import { ViewportPanel } from './SurfacePanels';
import { CenterExtensionLayer } from './CenterExtensionLayer';
import { usePanelRenderers } from '../DockShell/panelRenderers';
import './MainArea.css';

// 2026-05-17 — Bus mode tab + BusAdminPanel render here removed.
// Bus inventory is now a "Plugins" section inside SettingsPanel (overlay,
// opened via gear icon).
// 2026-06-30: 'preview'/'edit' merged into single 'viewport' mode.
// 2026-07-08 (v9): Scene workbench mode id renamed 'edit' → 'scene'.
export function MainArea() {
  // MainArea body is a 前L2 @forgeax/ai-workbench app injected via the
  // slots.MainAreaBody slot (R4); interface holds no @forgeax/ai-workbench import.
  const MainAreaBody = usePanelRenderers().slots?.MainAreaBody;
  // The 'main' dock panel exists ONLY in the AI workbench layout (Scene uses a
  // separate 'viewport' panel), so its body is always AI content. The
  // `activeId === 'scene'` ViewportPanel branch is only a fallback for
  // interface-alone hosts that inject no MainAreaBody. Derives directly from the
  // active workbench (the single source of truth) — no separate mode field.
  const activeId = useActiveWorkbench()?.id;
  return (
    <main className="main-area">
      {MainAreaBody ? (
        <div data-fx-slot="MainAreaBody" style={{ display: 'contents' }}>
          <MainAreaBody />
        </div>
      ) : (activeId === 'scene' ? <ViewportPanel /> : null)}
      {/* Always-mounted keep-alive overlay for standalone center plugins. Lives
          here (above the mode/tab conditionals) so plugin iframes survive
          viewport↔workbench and tab switches instead of cold-restarting. It
          self-hides when no standalone plugin is expanded. */}
      <CenterExtensionLayer />
    </main>
  );
}
