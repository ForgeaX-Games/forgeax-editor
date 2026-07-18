// Single entry for "make the live shell match what the home tour teaches":
 // Scene workbench + empty panelLocations + dock default layout.
 // DockRegion's epoch latch makes app.dock.reset safe before onReady.
 //
 // Re-entry caveat: during welcome/project the shell (and ProjectSwitcher) is
 // unmounted, so workbench writes land under currentProjectId='default'. When
 // home mounts, ProjectSwitcher.setCurrentProject(realId) can revive the real
 // project's stale activeId (e.g. 'ai') and win over the default-namespace
 // write — callers must re-apply after that notify (see OnboardingController).

import type { AppHost } from '../../core/app-shell';
import { setActiveWorkbench } from '../../lib/workbenches';
import { resetActivePanelLocations } from '../../lib/useWorkbench';
import { useShellStore } from '../../store';
import { bumpDockResetEpoch } from '../DockShell/dockResetEpoch';

/** Sync prep before Dock mounts (e.g. enterHomeWith → setPhase('home')). */
export function latchTourShellDefaults(): void {
  setActiveWorkbench('scene');
  useShellStore.getState().setMode('scene');
  resetActivePanelLocations();
  bumpDockResetEpoch();
}

/** Full prep once the shell exists: Scene tab + default dock layout. */
export function prepareTourShell(host: AppHost): void {
  setActiveWorkbench('scene');
  useShellStore.getState().setMode('scene');
  resetActivePanelLocations();
  void host.commands.execute('app.dock.reset');
}
