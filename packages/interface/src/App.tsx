import { useEffect } from 'react';
import { TopBar } from './components/TopBar/TopBar';
import { DockShell } from './components/DockShell/DockShell';
import { PanelRenderersProvider, DEFAULT_PANEL_RENDERERS, type PanelRenderers } from './components/DockShell/panelRenderers';
import { Dashboard } from './components/Dashboard/Dashboard';
import { GlobalStatusBar } from './components/StatusBar/GlobalStatusBar';
import { HealthIndicator } from './components/StatusBar/HealthIndicator';
import { PulseFeeds } from './components/StatusBar/feeds/PulseFeeds';
import { VersionBadge } from './components/StatusBar/VersionBadge';
import { SettingsPanel } from './components/SettingsPanel/SettingsPanel';
import { SettingsSectionsRegister } from './components/SettingsPanel/SectionsRegister';
import { ContextMenu } from './components/ContextMenu/ContextMenu';
import { ConfirmDialog } from './components/Confirm/ConfirmDialog';
import { FirstRunSetup } from './components/FirstRun/FirstRunSetup';
import { DialogHost } from './lib/dialog';
import { bootStageAppMounted } from './boot/driver';
import { useGlobalShortcuts } from './lib/global-shortcuts';
import { useAppStore } from './store';
import { buildEntityPill, buildAssetPill, buildComponentPill } from './components/Composer/referenceRegistry';
import { isTrustedMessageOrigin } from './lib/trustedOrigins';
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
  // ── ✎ Edit → chat reference pills ──────────────────────────────────────────
  // The editor iframe posts VAG_EDITOR_REF when the user "references to chat" a
  // scene entity / component / asset. Turn it into a composer pill via the shared
  // referenceRegistry builders. Restored after the EditMode→EditSurface slim
  // (0dccba7) dropped this listener; payload is validated inline so the interface
  // keeps ZERO dependency on @forgeax/editor (the cycle the panel-renderer
  // refactor 52b6f61 removed — re-importing the editor schema would re-create it).
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (!isTrustedMessageOrigin(ev.origin)) return; // foreign-origin guard
      const data = ev.data as { type?: unknown; payload?: unknown } | null;
      if (!data || data.type !== 'VAG_EDITOR_REF') return;
      const p = data.payload as Record<string, unknown> | null;
      if (!p || typeof p.kind !== 'string') return;
      const insert = useAppStore.getState().requestComposerInsert;
      if (p.kind === 'component' && typeof p.entityName === 'string' && typeof p.comp === 'string') {
        insert(buildComponentPill({
          entityId: typeof p.entityId === 'number' ? p.entityId : undefined,
          entityName: p.entityName, comp: p.comp, value: p.value,
        }));
      } else if (p.kind === 'asset' && typeof p.guid === 'string') {
        insert(buildAssetPill({
          guid: p.guid,
          name: typeof p.name === 'string' ? p.name : undefined,
          assetKind: typeof p.assetKind === 'string' ? p.assetKind : undefined,
          packPath: typeof p.packPath === 'string' ? p.packPath : undefined,
        }));
      } else if (p.kind === 'entity' && (typeof p.id === 'number' || typeof p.id === 'string') && typeof p.name === 'string') {
        insert(buildEntityPill({
          id: p.id, name: p.name, components: p.components,
          source: (p.source ?? undefined) as { plugin?: string; docId?: string } | undefined,
        }));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
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
      {/* Latest-health indicator — a compact chip pinned to the FAR RIGHT of the
          GlobalStatusBar (severity icon + truncated latest message + ✖N⚠N).
          Replaces the old full-width HealthStatusBar strip: the full log now
          lives only in the Info dock panel (click the chip to open it). The
          Play/Edit fatal banner is a separate concern, kept and mounted by the
          surface wrappers (SurfacePanels → FatalBanner). */}
      <HealthIndicator />
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
