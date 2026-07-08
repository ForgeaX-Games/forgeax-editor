import { useEffect } from 'react';
import { TopBar } from './components/TopBar/TopBar';
import { DockShell } from './components/DockShell/DockShell';
import { PanelRenderersProvider, DEFAULT_PANEL_RENDERERS, type PanelRenderers } from './components/DockShell/panelRenderers';
import { SurfaceKeepAliveLayer } from './components/Surfaces/SurfaceKeepAliveLayer';
import { GlobalStatusBar } from './components/StatusBar/GlobalStatusBar';
import { HealthIndicator } from './components/StatusBar/HealthIndicator';
import { PulseFeeds } from './components/StatusBar/feeds/PulseFeeds';
import { VersionBadge } from './components/StatusBar/VersionBadge';
import { ContextMenu } from './components/ContextMenu/ContextMenu';
import { FirstRunSetup } from './components/FirstRun/FirstRunSetup';
import { DialogHost } from './lib/dialog';
import { bootStageAppMounted } from './boot/driver';
import { useGlobalShortcuts } from './lib/global-shortcuts';
import { useAppStore } from './store';
import { buildEntityPill, buildAssetPill, buildComponentPill, requestComposerInsert } from './lib/composer-bridge';
import { isTrustedMessageOrigin } from './lib/trustedOrigins';
import { APP_EVENTS } from './lib/storageKeys';
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
  // The editor posts VAG_EDITOR_REF (via editorBus compat bridge) when the user
  // "references to chat" a scene entity / component / asset. Turn it into a
  // composer pill via the shared referenceRegistry builders. Payload is validated
  // inline so the interface keeps ZERO dependency on @forgeax/editor.
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (!isTrustedMessageOrigin(ev.origin)) return; // foreign-origin guard
      const data = ev.data as { type?: unknown; payload?: unknown } | null;
      if (!data || data.type !== 'VAG_EDITOR_REF') return;
      const p = data.payload as Record<string, unknown> | null;
      if (!p || typeof p.kind !== 'string') return;
      const insert = requestComposerInsert;
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

  // ── ✎ Content Browser → Chat: batch asset/folder refs (M5) ────────────────
  useEffect(() => {
    const onBatchRef = (ev: MessageEvent) => {
      if (!isTrustedMessageOrigin(ev.origin)) return;
      const data = ev.data as { type?: unknown; refs?: unknown } | null;
      if (!data || data.type !== 'FORGEAX_ADD_ASSET_TO_CHAT' || !Array.isArray(data.refs)) return;
      const insert = requestComposerInsert;
      for (const ref of data.refs as Array<Record<string, unknown>>) {
        if (ref.type === 'asset' && typeof ref.guid === 'string') {
          insert(buildAssetPill({
            guid: ref.guid,
            name: typeof ref.name === 'string' ? ref.name : undefined,
            assetKind: typeof ref.kind === 'string' ? ref.kind : undefined,
            packPath: typeof ref.path === 'string' ? ref.path : undefined,
            payload: ref.payload as Record<string, unknown> | undefined,
          }));
        } else if (ref.type === 'folder' && typeof ref.path === 'string') {
          insert(buildAssetPill({
            guid: `folder:${ref.path}`,
            name: typeof ref.name === 'string' ? `📁 ${ref.name}` : '📁 Folder',
            assetKind: 'folder',
            packPath: typeof ref.path === 'string' ? ref.path : undefined,
            payload: ref.summary as Record<string, unknown> | undefined,
          }));
        }
      }
    };
    window.addEventListener('message', onBatchRef);
    return () => window.removeEventListener('message', onBatchRef);
  }, []);

  // ── ✎ Edit → focus a dock panel (e.g. double-click a mesh → Mesh tab) ───────
  // The editor posts FORGEAX_FOCUS_PANEL { panel } (via editorBus compat bridge)
  // to bring a panel to front. Relayed as APP_EVENTS.focusPanel CustomEvent so
  // DockShell activates the tab WITHOUT reopening a closed one (no force-insert).
  // Design: docs/design/editor-mesh-panel-ue58-parity.md §7.1.
  useEffect(() => {
    const onFocusPanel = (ev: MessageEvent) => {
      if (!isTrustedMessageOrigin(ev.origin)) return; // foreign-origin guard
      const data = ev.data as { type?: unknown; panel?: unknown } | null;
      if (!data || data.type !== 'FORGEAX_FOCUS_PANEL' || typeof data.panel !== 'string') return;
      window.dispatchEvent(new CustomEvent(APP_EVENTS.focusPanel, { detail: { id: `ep:${data.panel}` } }));
    };
    window.addEventListener('message', onFocusPanel);
    return () => window.removeEventListener('message', onFocusPanel);
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
        {/* Always-mounted keep-alive owner of the Play + Edit viewport surfaces.
            Lives OUTSIDE the dockview tree (which rebuilds on every Play/Edit/AI
            workspace switch) so the heavy viewport iframes are mounted once and
            kept alive across switches — paused in the background, never rebooted.
            Kills the "switch Play→Edit and the app freezes" cold-reboot hang.
            Renders the real surfaces via PanelRenderers context (no editor import);
            positions the active one over its dockview anchor. */}
        <SurfaceKeepAliveLayer />
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
      {/* Dashboard overlay — injected by studio from `@forgeax/dashboard` (R4
          前L2 app). Toggled open via the TopBar gauge icon; its open/sessions
          state lives in interface's L1 store, only the body comes through the
          renderDashboard slot. Omitted (interface-alone) → no overlay. */}
      {(panelRenderers ?? DEFAULT_PANEL_RENDERERS).renderDashboard?.()}
      {/* Settings overlay — injected by studio from `@forgeax/settings` (R4
          前L2 app). The slot mounts BOTH the sections-register side-effect and
          the unified settings panel; settingsOpen/section state lives in
          interface's L1 store. Omitted (interface-alone) → no overlay. */}
      {(panelRenderers ?? DEFAULT_PANEL_RENDERERS).renderSettings?.()}
      <ContextMenu />
      {/* Imperative async confirm()/alert() replacement (shadcn AlertDialog). */}
      <DialogHost />
    </div>
    </PanelRenderersProvider>
  );
}
