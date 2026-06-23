import { useEffect } from 'react';
import { TopBar } from './components/TopBar/TopBar';
import { DockShell } from './components/DockShell/DockShell';
import { PanelRenderersProvider, DEFAULT_PANEL_RENDERERS, type PanelRenderers } from './components/DockShell/panelRenderers';
import { Dashboard } from './components/Dashboard/Dashboard';
import { GlobalStatusBar } from './components/StatusBar/GlobalStatusBar';
import { PulseFeeds } from './components/StatusBar/feeds/PulseFeeds';
import { VersionBadge } from './components/StatusBar/VersionBadge';
import { SettingsPanel } from './components/SettingsPanel/SettingsPanel';
import { SettingsSectionsRegister } from './components/SettingsPanel/SectionsRegister';
import { ContextMenu } from './components/ContextMenu/ContextMenu';
import { SurfaceOverlay } from './components/Surfaces/SurfaceOverlay';
import { ConfirmDialog } from './components/Confirm/ConfirmDialog';
import { FirstRunSetup } from './components/FirstRun/FirstRunSetup';
import { DialogHost } from './lib/dialog';
import { bootStageAppMounted } from './boot/driver';
import { useGlobalShortcuts } from './lib/global-shortcuts';
import { useAppStore } from './store';
import './App.css';

export interface AppProps {
  /**
   * BANDAGE — opt-out for the studio chrome's chat surface and the Forge
   * agent entry, used by the standalone editor host
   * (`packages/editor/standalone/main.tsx`). When `true`, the App shell
   * skips rendering the ChatPanel container (via DockShell prop) and the
   * TopBar Forge entry region (via TopBar prop). When `false` / omitted,
   * the studio chrome is unchanged (AC-16). See plan-strategy section 2
   * D-4 and ADR-0018 for the bandage rationale and scheduled removal once
   * chat migrates to a dedicated `@forgeax/chat` L2 app.
   */
  hideChatAndForge?: boolean;
  /**
   * Host-injected editor-specific panel renderers (edit/preview surfaces +
   * editor panel id list). Keeps interface editor-agnostic: studio supplies
   * the real `@forgeax/editor` surfaces; interface-alone falls back to neutral
   * placeholders. See components/DockShell/panelRenderers.ts.
   */
  panelRenderers?: PanelRenderers;
}

export function App({ hideChatAndForge, panelRenderers }: AppProps = {}) {
  // Global Ctrl+Shift+... shortcuts (Blender-style, IME-safe). See
  // lib/global-shortcuts.ts for the keymap.
  useGlobalShortcuts();
  const fullscreen        = useAppStore((s) => s.fullscreen);
  const sidebarCollapsed  = useAppStore((s) => s.sidebarCollapsed);
  const chatpanelCollapsed = useAppStore((s) => s.chatpanelCollapsed);
  // Drive the boot splash to "ready" after the first React paint. Two rAF
  // ticks inside bootStageAppMounted() guarantee the studio shell is on
  // screen before the splash fades, otherwise users see a brief blank frame.
  useEffect(() => {
    bootStageAppMounted();
  }, []);
  // WAL replay trigger lives in ChatPanel — it watches activeTab.agentId
  // and re-fires loadSession on every change. No mount hook here so the
  // trigger has a single owner.
  return (
    <PanelRenderersProvider value={panelRenderers ?? DEFAULT_PANEL_RENDERERS}>
    <div
      className="studio-shell studio-shell--preview-skin"
      data-fullscreen={fullscreen ? '1' : undefined}
      data-sidebar-collapsed={sidebarCollapsed ? '1' : undefined}
      data-chatpanel-collapsed={chatpanelCollapsed ? '1' : undefined}
    >
      <FirstRunSetup />
      <TopBar hideChatAndForge={hideChatAndForge} />
      {/* Dockable workspace (dockview) — replaces the fixed Sidebar | MainArea |
          ChatPanel panes. Each region is now a drag/dock/tab/float panel with a
          persisted layout. TopBar + the status bar below stay fixed chrome.
          hideChatAndForge prop drills into DockShell so the standalone editor
          host (packages/editor/standalone/) skips the auto-mount of the chat
          panel — plan-strategy section 2 D-4. */}
      <div className="studio-body">
        <DockShell hideChatAndForge={hideChatAndForge} />
      </div>
      {/* Blender-style global status bar at the very bottom.  Any component
          can register a chip via `useStatusBarItem(...)`.  PulseFeeds owns
          the BUS / MB / PROV / SKILL / TOOL / AGENT live indicators that
          used to live in PreviewMode's pt-right toolbar (2026-05-17). */}
      <PulseFeeds />
      {/* VersionBadge pins forgeax-studio's version (v0.M.D.N) as the
          leftmost permanent chip in the status bar. Source: /api/version
          → packages/server/src/api/version.ts. Scheme + rules in CHANGELOG.md. */}
      <VersionBadge />
      <GlobalStatusBar />
      {/* Dashboard renders as a top-of-stack overlay when toggled open via
          the TopBar gauge icon. It does NOT replace the studio shell — the
          underlying chat/preview keeps state so closing the dashboard is
          instant. */}
      <Dashboard />
      {/* SettingsPanel — the unified settings overlay that absorbed the old
          right-slide SettingsDrawer + the TopBar Bus mode tab.  Sections are
          registered via SettingsSectionsRegister; any other component can
          drop its own section with useSettingsSection(). */}
      <SettingsSectionsRegister />
      <SettingsPanel />
      <ContextMenu />
      {/* Phase D2 — dev-mode surface overlay. Floats bottom-right showing
          every plugin iframe's `surface.expose` snapshot ("this button
          equals tool X"). Hidden in production builds via DEV check inside
          the component. */}
      <SurfaceOverlay />
      {/* Doc 07 §9.5 — host-side confirm dialog. Listens for
          `tool.confirm-required` envelopes off the SSE stream and POSTs
          the user's verdict back to /api/tools/confirm. */}
      <ConfirmDialog />
      {/* Imperative async confirm()/alert() replacement (shadcn AlertDialog). */}
      <DialogHost />
    </div>
    </PanelRenderersProvider>
  );
}
