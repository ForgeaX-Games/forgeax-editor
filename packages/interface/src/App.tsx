// packages/interface/src/App.tsx
//
// Thin shell: builds an AppHost via bootstrapAppHost() (which loads the
// built-in plugin list + any studio-injected overrides), mounts <HostProvider>,
// and renders the fixed chrome (TopBar / DockShell / SurfaceKeepAliveLayer /
// GlobalStatusBar / overlays / modals). All side effects — postMessage
// listeners, editor-ref pills, focus-panel routing, builtin actions — live in
// plugins now (see core/plugins/*). This file only owns:
//   - global shortcut binding (reads store; not a plugin concern)
//   - reading store flags for shell chrome data-attrs
//   - overlays / status-feeds slot rendering (via host.panels)
//   - triggering bootStageAppMounted() AFTER host boot completes

import { useEffect, useState } from 'react';
import { TopBar } from './components/TopBar/TopBar';
import { DockRegion } from './components/DockShell/DockRegion';
import { PanelRenderersProvider, type PanelRenderers } from './components/DockShell/panelRenderers';
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
import { bootstrapAppHost, type AppHostBootstrapOverrides } from './appHostBootstrap';
import { HostProvider, type AppHost } from './core/app-shell';
import './App.css';

export interface AppProps {
  /** Studio injects concrete overlay / surface / slot / detached / editor plugins. */
  overrides?: AppHostBootstrapOverrides;
  /** LEGACY escape hatch for interface-alone callers still passing a
   *  full PanelRenderers object without plugins. Merged into host.panels
   *  one-shot after boot; downstream still reads through host.panels. */
  panelRenderers?: PanelRenderers;
}

export function App({ overrides, panelRenderers }: AppProps = {}): React.ReactElement | null {
  useGlobalShortcuts();
  const fullscreen         = useShellStore((s) => s.fullscreen);
  const sidebarCollapsed   = useShellStore((s) => s.sidebarCollapsed);
  const chatpanelCollapsed = useShellStore((s) => s.chatpanelCollapsed);
  // §14 three-state boot: during welcome/project (init) we render ONLY the
  // onboarding — no TopBar/DockShell/status bar — so the shell never binds to a
  // project the user hasn't picked yet. Full shell mounts at home/done.
  const onboardingPhase = useOnboardingPhase();
  const shellHidden = onboardingPhase === 'welcome' || onboardingPhase === 'project';

  const [host, setHost] = useState<AppHost | null>(null);

  useEffect(() => {
    let disposed = false;
    let dispose: (() => Promise<void>) | null = null;
    void bootstrapAppHost(overrides).then((r) => {
      if (disposed) { void r.dispose(); return; }
      if (panelRenderers) Object.assign(r.host.panels, panelRenderers);
      setHost(r.host);
      dispose = r.dispose;
      bootStageAppMounted();
    });
    return () => { disposed = true; void dispose?.(); };
  }, [overrides, panelRenderers]);

  if (!host) return null;

  const renderers = host.panels;
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
          </div>
          {StatusFeeds && <div data-fx-slot="StatusFeeds" style={{ display: 'contents' }}><StatusFeeds /></div>}
          <HealthIndicator />
          <GlobalStatusBar />
          {Dashboard && <div data-fx-slot="Dashboard" style={{ display: 'contents' }}><Dashboard /></div>}
          {Settings && <div data-fx-slot="Settings" style={{ display: 'contents' }}><Settings /></div>}
          <ContextMenu />
          <CommandPalette />
          <DialogHost />
          {isSlotDebugEnabled() && <SlotDebugOverlay />}
        </div>
      </PanelRenderersProvider>
    </HostProvider>
  );
}
