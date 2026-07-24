// packages/interface/src/App.tsx
//
// Thin shell: builds an AppHost via bootstrapAppHost() (which loads the
// built-in plugin list + any studio-injected overrides), mounts <HostProvider>,
// and renders the fixed chrome (TopBar / DockShell / SurfaceKeepAliveLayer /
// GlobalStatusBar / overlays / modals). All side effects — postMessage
// listeners, editor-ref pills, focus-panel routing, builtin actions — live in
// plugins now (see core/extensions/*). This file only owns:
//   - global shortcut binding (reads store; not a plugin concern)
//   - reading store flags for shell chrome data-attrs
//   - overlays / status-feeds slot rendering (via host.panels)
//   - triggering bootStageAppMounted() AFTER host boot completes

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { TopBar } from './components/TopBar/TopBar';
import { ProjectModalHost } from './components/TopBar/ProjectSwitcher';
import { GameModalHost } from './components/TopBar/GameSwitcher';
import { ActivityRail } from './components/ActivityRail/ActivityRail';
import { ChatColumn } from './components/ChatColumn/ChatColumn';
import { DockRegion } from './components/DockShell/DockRegion';
import { PanelRenderersProvider, DEFAULT_PANEL_RENDERERS } from './components/DockShell/panelRenderers';
import { SurfaceKeepAliveLayer } from './components/Surfaces/SurfaceKeepAliveLayer';
import { GlobalStatusBar } from './components/StatusBar/GlobalStatusBar';
import { HealthIndicator } from './components/StatusBar/HealthIndicator';
import { ContextMenu } from './components/ContextMenu/ContextMenu';
import { CommandPalette } from './components/CommandPalette/CommandPalette';
import { OnboardingController, ConnectModelPrompt } from './components/Onboarding';
import { useOnboardingPhase } from './components/Onboarding/types';
import { DialogHost } from './lib/dialog';
import { SlotDebugOverlay, isSlotDebugEnabled } from './components/SlotDebugOverlay';
import { bootStageAppMounted } from './boot/driver';
import { useGlobalShortcuts } from './lib/global-shortcuts';
import { useShellStore } from './store';
import { bootstrapAppHost, type AppHostBootstrapOverrides, type AppHostBootstrapResult } from './appHostBootstrap';
import { HostProvider } from './core/app-shell';
import { useTranslation } from '@/i18n';
import { initNativeMenuBridge } from './lib/native-menu-bridge';
import { isTauri } from './lib/platform/runtime';
import './App.css';

export interface AppProps {
  /** Studio injects concrete overlay / surface / slot / detached / editor
   *  extensions here (ADR 0025 M1 — the sole assembly channel; the legacy
   *  `panelRenderers` escape hatch was removed once studio migrated). */
  overrides?: AppHostBootstrapOverrides;
}

export function App({ overrides }: AppProps = {}): React.ReactElement | null {
  useGlobalShortcuts();
  const { t } = useTranslation();
  const fullscreen         = useShellStore((s) => s.fullscreen);
  const sidebarCollapsed   = useShellStore((s) => s.sidebarCollapsed);
  const chatpanelCollapsed = useShellStore((s) => s.chatpanelCollapsed);
  // §14 three-state boot: during welcome/project (init) we render ONLY the
  // onboarding — no TopBar/DockShell/status bar — so the shell never binds to a
  // project the user hasn't picked yet. Full shell mounts at home/done.
  const onboardingPhase = useOnboardingPhase();
  const shellHidden = onboardingPhase === 'welcome' || onboardingPhase === 'project';

  const [boot, setBoot] = useState<AppHostBootstrapResult | null>(null);

  useEffect(() => {
    let disposed = false;
    let dispose: (() => Promise<void>) | null = null;
    void bootstrapAppHost(overrides).then((r) => {
      if (disposed) { void r.dispose(); return; }
      setBoot(r);
      dispose = r.dispose;
      bootStageAppMounted();
    });
    return () => { disposed = true; void dispose?.(); };
  }, [overrides]);

  // T5: install the Tauri native menu bar once the host is available. The
  // bridge is idempotent (its own `installed` guard) and no-ops in the browser
  // form, so we can fire-and-forget without worrying about StrictMode double-
  // effect or web-mode overhead. Kept minimal — bridge owns the details.
  useEffect(() => {
    if (!boot || !isTauri()) return;
    void initNativeMenuBridge({
      execute: (id, args) => boot.host.commands.execute(id, args),
      translate: t,
    });
  }, [boot, t]);

  // ADR 0025 M2: host.panels is a version-memoized DERIVED snapshot of the
  // contribution registry. Subscribing here means post-boot contributions and
  // extension cleanups (e.g. capability-driven deactivation) re-render the
  // shell — a new snapshot identity flows down PanelRenderersProvider.
  const subscribePanels = useMemo(
    () => (boot ? (cb: () => void) => boot.control.onPanelsChange(cb) : (_: () => void) => () => {}),
    [boot],
  );
  const renderers = useSyncExternalStore(
    subscribePanels,
    () => (boot ? boot.host.panels : DEFAULT_PANEL_RENDERERS),
  );

  if (!boot) return null;
  const host = boot.host;

  const StatusFeeds = renderers.chrome?.StatusFeeds;
  const Dashboard   = renderers.overlays?.Dashboard;
  const Settings    = renderers.overlays?.Settings;

  // Init state (welcome/project): render ONLY the onboarding + dialog host over
  // a bare shell frame — no TopBar/DockShell/surfaces/status bar. Keeps all
  // hooks above unconditional (rules-of-hooks) by branching in the returned tree.
  if (shellHidden) {
    return (
      <HostProvider value={host}>
        <PanelRenderersProvider value={renderers}>
          <div className="studio-shell studio-shell--preview-skin">
            <OnboardingController />
            <DialogHost />
          </div>
        </PanelRenderersProvider>
      </HostProvider>
    );
  }

  return (
    <HostProvider value={host}>
      <PanelRenderersProvider value={renderers}>
        <div
          className="studio-shell studio-shell--preview-skin"
          data-fullscreen={fullscreen ? '1' : undefined}
          data-sidebar-collapsed={sidebarCollapsed ? '1' : undefined}
          data-chatpanel-collapsed={chatpanelCollapsed ? '1' : undefined}
        >
          <OnboardingController />
          <ConnectModelPrompt />
          <TopBar />
          <div className="studio-body">
            <DockRegion region="DockShell" />
            <DockRegion region="AuxBar" />
            <SurfaceKeepAliveLayer />
            {/* ActivityRail + chat are fixed shell columns on the right, so the
                rail sits immediately left of the (drag-resizable) chat column
                regardless of dock layout. */}
            <ActivityRail />
            <ChatColumn />
          </div>
          {StatusFeeds && <div data-fx-slot="StatusFeeds" style={{ display: 'contents' }}><StatusFeeds /></div>}
          <HealthIndicator />
          <GlobalStatusBar />
          {Dashboard && <div data-fx-slot="Dashboard" style={{ display: 'contents' }}><Dashboard /></div>}
          {Settings && <div data-fx-slot="Settings" style={{ display: 'contents' }}><Settings /></div>}
          <ContextMenu />
          <CommandPalette />
          <ProjectModalHost />
          <GameModalHost />
          <DialogHost />
          {isSlotDebugEnabled() && <SlotDebugOverlay />}
        </div>
      </PanelRenderersProvider>
    </HostProvider>
  );
}
