import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { FloatingMenu } from '../ui/FloatingMenu';
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewHeaderActionsProps } from 'dockview';
import 'dockview/dist/styles/dockview.css';
import { WbPluginDockPanel } from './WbPluginDockPanel';
import { getWindowManager } from '../../lib/platform';
import { listBusPlugins, pickLang, type BusPluginInfo } from '../../lib/bus-api';
import { useAppStore } from '../../store';
// Panel registry — single declarative source for dockview panels (§C1).
import {
  PANEL_COMPONENTS as BASE_COMPONENTS,
  PANEL_TITLE,
  CORE_PANEL_IDS as PANEL_IDS,
  OPTIONAL_PANEL_IDS as OPTIONAL_IDS,
  SURFACE_PANEL_IDS as SURFACE_PANELS,
  EDITOR_PANEL_IDS,
  EDITOR_PANEL_TITLE,
} from './panelRegistry';
import {
  loadWorkspaces,
  loadWorkspaceLayout,
  saveWorkspaceLayout,
  subscribeWorkspaces,
  initWorkspaceLayouts,
  migrateLayoutVersion,
} from '../../lib/workspaces';
import { STORAGE_KEYS, APP_EVENTS } from '../../lib/storageKeys';
import './DockShell.css';

// DockShell — the interface shell's window/docking layer (design EDITOR-MODE §0.2,
// chosen lib = dockview). Replaces the fixed Sidebar | MainArea | ChatPanel 3-pane
// layout with a real dockable workspace: every region is a dockview panel that can
// be dragged to dock / split / tab / float, with the layout persisted to
// localStorage. TopBar + StatusBar stay as fixed chrome (outside the dock tree).
//
// Panel taxonomy + the full id/title/group/pop-out table now live in
// ./panelRegistry.tsx — add a panel THERE, not by editing constants here.
//   CORE     — workbench / preview / edit / chat
//   OPTIONAL — agents / files / console (布局 menu toggles)
//   EDITOR   — ep:* editor sub-panels (iframe to /editor/?panel=<id>)
//   PLUGINS  — wb:<pluginId> panels merged in at runtime (below)

const LS_KEY = STORAGE_KEYS.legacyDockLayout;  // legacy — only read for migration to workspace layouts

function buildDefault(api: DockviewApi, workspaceId: string = 'edit'): void {
  if (workspaceId === 'preview') {
    // Preview workspace: game preview + CLI chat side by side
    api.addPanel({ id: 'preview', component: 'preview', title: 'Preview' });
    api.addPanel({ id: 'chat', component: 'chat', title: 'ForgeaX CLI', position: { referencePanel: 'preview', direction: 'right' } });
    try { api.getPanel('chat')?.api.setSize({ width: 360 }); } catch { /* sizing best-effort */ }
    return;
  }
  if (workspaceId === 'workbench') {
    // Workbench: tools sidebar | workbench main area (WorkbenchMode) | chat
    api.addPanel({ id: 'workbench', component: 'workbench', title: 'Tools' });
    api.addPanel({ id: 'main', component: 'main', title: 'Workbench', position: { referencePanel: 'workbench', direction: 'right' } });
    api.addPanel({ id: 'chat', component: 'chat', title: 'ForgeaX CLI', position: { referencePanel: 'main', direction: 'right' } });
    try {
      api.getPanel('workbench')?.api.setSize({ width: 300 });
      api.getPanel('chat')?.api.setSize({ width: 380 });
    } catch { /* sizing best-effort */ }
    return;
  }

  // Custom workspaces (not edit/preview/workbench): use the AI layout as a
  // sensible starting point — Tools sidebar | Workbench main | Chat.
  // This avoids blank ep:* iframe panels when the editor server isn't running.
  if (workspaceId !== 'edit') {
    api.addPanel({ id: 'workbench', component: 'workbench', title: 'Tools' });
    api.addPanel({ id: 'main', component: 'main', title: 'Workbench', position: { referencePanel: 'workbench', direction: 'right' } });
    api.addPanel({ id: 'chat', component: 'chat', title: 'ForgeaX CLI', position: { referencePanel: 'main', direction: 'right' } });
    try {
      api.getPanel('workbench')?.api.setSize({ width: 300 });
      api.getPanel('chat')?.api.setSize({ width: 380 });
    } catch { /* sizing best-effort */ }
    return;
  }

  // 'edit' workspace: full editor layout (3 columns, each split top/bottom).
  //   ┌──────────┬─────────────────────────┬──────────────┐
  //   │ Hierarchy│      Edit viewport      │ Inspector·Mat │
  //   │──────────│   (dominant, largest)   │──────────────│
  //   │ Assets   │ History·Timeline·Capab  │ ForgeaX CLI   │
  //   └──────────┴─────────────────────────┴──────────────┘
  //
  // ORDER MATTERS: add the three TOP-ROW anchors first (hierarchy → edit →
  // inspector) so dockview commits to 3 real columns; only THEN split each
  // column downward. Adding a bottom panel (e.g. Assets) before the columns
  // exist makes dockview attach it full-width across the bottom — the old bug
  // that crushed the viewport and stranded Assets in an empty full-width strip.
  api.addPanel({ id: 'ep:hierarchy', component: 'ep:hierarchy', title: PANEL_TITLE['ep:hierarchy'] ?? 'Hierarchy' });
  api.addPanel({ id: 'edit', component: 'edit', title: 'Edit', position: { referencePanel: 'ep:hierarchy', direction: 'right' } });
  api.addPanel({ id: 'ep:inspector', component: 'ep:inspector', title: PANEL_TITLE['ep:inspector'] ?? 'Inspector', position: { referencePanel: 'edit', direction: 'right' } });
  // Top-right tab group: Inspector + Material (Inspector active).
  api.addPanel({ id: 'ep:material', component: 'ep:material', title: PANEL_TITLE['ep:material'] ?? 'Material', position: { referencePanel: 'ep:inspector', direction: 'within' } });
  // Split each column downward now that all three columns are established.
  api.addPanel({ id: 'ep:assets', component: 'ep:assets', title: PANEL_TITLE['ep:assets'] ?? 'Assets', position: { referencePanel: 'ep:hierarchy', direction: 'below' } });
  api.addPanel({ id: 'ep:history', component: 'ep:history', title: PANEL_TITLE['ep:history'] ?? 'History', position: { referencePanel: 'edit', direction: 'below' } });
  api.addPanel({ id: 'ep:timeline', component: 'ep:timeline', title: PANEL_TITLE['ep:timeline'] ?? 'Timeline', position: { referencePanel: 'ep:history', direction: 'within' } });
  api.addPanel({ id: 'ep:capabilities', component: 'ep:capabilities', title: PANEL_TITLE['ep:capabilities'] ?? 'Capabilities', position: { referencePanel: 'ep:history', direction: 'within' } });
  // Fix-up I-3: matgraph + launcher were missing from the 'edit' default
  // layout (EDITOR_PANELS SSOT = 9 ids, buildDefault only seeded 7 ep:*
  // panels). Add matgraph as a tab alongside inspector/material in the
  // top-right column group, chat below inspector, and launcher as a tab
  // alongside chat.
  api.addPanel({ id: 'ep:matgraph', component: 'ep:matgraph', title: PANEL_TITLE['ep:matgraph'] ?? 'Mat Graph', position: { referencePanel: 'ep:material', direction: 'within' } });
  api.addPanel({ id: 'chat', component: 'chat', title: 'ForgeaX CLI', position: { referencePanel: 'ep:inspector', direction: 'below' } });
  api.addPanel({ id: 'ep:launcher', component: 'ep:launcher', title: PANEL_TITLE['ep:launcher'] ?? 'Launcher', position: { referencePanel: 'chat', direction: 'within' } });
  try {
    api.getPanel('ep:hierarchy')?.api.setSize({ width: 240 });
    api.getPanel('ep:inspector')?.api.setSize({ width: 340 });
    api.getPanel('ep:history')?.api.setSize({ height: 200 });
    api.getPanel('ep:assets')?.api.setSize({ height: 260 });
    api.getPanel('chat')?.api.setSize({ height: 340 });
    // Make the primary tab active in each tab group (last-added wins otherwise).
    api.getPanel('ep:inspector')?.api.setActive();
    api.getPanel('ep:history')?.api.setActive();
    api.getPanel('chat')?.api.setActive();
  } catch { /* sizing best-effort */ }
}

// Pop a dock panel OUT into a REAL OS window (Tauri WebviewWindow loading
// Pop a dock panel OUT into a REAL OS window. Two paths:
//   - ep:* panels  → /editor/?panel=<id>&scene=<slug>  (editor BroadcastChannel panel)
//   - other panels → index.html?surface=panel&id=<id>  (DetachedSurface)
// No-op in the browser (canDetach() false) — web users tear off via drag-float.
function popPanelToWindow(
  api: DockviewApi,
  id: string,
  pos?: { x: number; y: number },
  scene?: string,
  onClosed?: () => void,
): void {
  const wm = getWindowManager();
  if (!wm.canDetach()) return;

  if (id.startsWith('ep:')) {
    const panelId = id.slice(3);
    const sceneParam = scene && scene !== 'default' ? `&scene=${encodeURIComponent(scene)}` : '';
    const url = `/editor/?panel=${encodeURIComponent(panelId)}${sceneParam}`;
    const title = PANEL_TITLE[id] ?? panelId;
    void wm
      .openLabeledWindow(`fx-ep-${panelId}`, url, { title, width: 320, height: 560, ...(pos ?? {}) }, onClosed)
      .then((ok) => { if (ok) api.getPanel(id)?.api.close(); });
    return;
  }

  if (!SURFACE_PANELS.has(id)) return;
  void wm
    .openSurfaceWindow(
      { kind: 'panel', id },
      { title: PANEL_TITLE[id] ?? id, width: 480, height: 680, ...(pos ?? {}) },
    )
    .then((ok) => { if (ok) api.getPanel(id)?.api.close(); });
}

// Per-group header affordance: explicit "pop out to OS window" button, shown
// only in Tauri (#10). Reliable counterpart to drag-tear-off.
function PanelPopoutAction(props: IDockviewHeaderActionsProps): React.ReactNode {
  if (!getWindowManager().canDetach()) return null;
  const id = props.activePanel?.id;
  if (!id || !SURFACE_PANELS.has(id)) return null;
  return (
    <button
      type="button"
      className="fx-dock-popout"
      title="弹出为独立 OS 窗口"
      onClick={() => popPanelToWindow(props.containerApi, id)}
    >
      ⧉
    </button>
  );
}

export interface DockShellProps {
  /**
   * BANDAGE — when `true`, the dock shell does NOT auto-mount the
   * `chat` panel for any workspace's default layout, and any restored
   * layout that contains a chat panel has it closed immediately after
   * fromJSON. Drilled in from App.tsx for the standalone editor host
   * (`packages/editor/standalone/main.tsx`); plan-strategy section 2 D-4
   * routes the prop here so the chat surface can stay out of the DOM
   * for AC-09 (testid `chat-panel` must not exist when hideChatAndForge
   * is true). When `false` / omitted the studio dock is unchanged.
   */
  hideChatAndForge?: boolean;
}

export function DockShell({ hideChatAndForge }: DockShellProps = {}) {
  const apiRef = useRef<DockviewApi | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const draggedIdRef = useRef<string | null>(null);
  const dropHandledRef = useRef(false);
  const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // Keep the active scene slug + reopen callback accessible inside the drag-end
  // closure without re-registering the event listener on every change.
  const sceneSlugRef = useRef<string>('');
  const pinnedSlug = useAppStore((s) => s.pinnedSlug);
  useEffect(() => { sceneSlugRef.current = pinnedSlug ?? ''; }, [pinnedSlug]);
  const reopenRef = useRef<(id: string) => void>(() => {});
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const chatpanelCollapsed = useAppStore((s) => s.chatpanelCollapsed);
  const fullscreen = useAppStore((s) => s.fullscreen);
  // Mirror hideChatAndForge into a ref so onReady (memoised with [] deps to
  // satisfy dockview's once-per-mount contract) and async restore branches
  // can read the latest value without re-binding.
  const hideChatRef = useRef<boolean>(!!hideChatAndForge);
  useEffect(() => { hideChatRef.current = !!hideChatAndForge; }, [hideChatAndForge]);
  // Active bus workbench plugins — used to populate the "插件面板" layout section.
  const [busPlugins, setBusPlugins] = useState<BusPluginInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    void listBusPlugins('workbench').then((res) => { if (!cancelled) setBusPlugins(res.items ?? []); });
    return () => { cancelled = true; };
  }, []);

  // Dynamic components map: extends the static map with wb:<pluginId> renderers
  // so each plugin panel renders its own WbPluginDockPanel.
  const components = useMemo(() => ({
    ...BASE_COMPONENTS,
    ...Object.fromEntries(busPlugins.map((p) => [
      `wb:${p.id}`,
      () => <WbPluginDockPanel pluginId={p.id} />,
    ])),
  }), [busPlugins]);
  const preFullscreen = useRef<{ workbench: boolean; chat: boolean } | null>(null);
  // Track the workspace id that is currently rendered in the dock so we can
  // save its layout before switching. Lives outside onReady so useEffect cleanup
  // can unsubscribe correctly on HMR remounts.
  const prevWorkspaceIdRef = useRef(loadWorkspaces().activeId);
  // Track which panels were hidden by the collapse toggle (not by the user clicking ×).
  // Only these panels get reopened when the toggle is expanded again — prevents
  // the "close fails" bug where manually-closed panels came back on sidebar toggle.
  const hiddenByToggleRef = useRef(new Set<string>());

  const onReady = useCallback((event: DockviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__dockApi = api;

    // If the built-in default-layout version advanced, discard every stale saved
    // layout so we rebuild from the current buildDefault(). Must run BEFORE any
    // restore — otherwise the old arrangement loads and gets re-saved.
    migrateLayoutVersion();

    // Workspace-aware persistence: save to the current workspace's slot on every change.
    api.onDidLayoutChange(() => {
      saveWorkspaceLayout(prevWorkspaceIdRef.current, api.toJSON());
      bump();
    });

    api.onWillDragPanel((e) => {
      draggedIdRef.current = e.panel.id;
      dropHandledRef.current = false;
      const ne = e.nativeEvent as { clientX?: number; clientY?: number };
      dragStartRef.current = { x: ne.clientX ?? 0, y: ne.clientY ?? 0 };
    });
    api.onDidDrop(() => { dropHandledRef.current = true; });

    // Restore the active workspace's layout, falling back to legacy LS_KEY for
    // the 'edit' workspace on first migration, else build the workspace default.
    const { activeId } = loadWorkspaces();
    prevWorkspaceIdRef.current = activeId;
    let restored = false;
    // isValidLayout — checks the raw serialized JSON BEFORE giving it to dockview.
    // Rejects it early so we never briefly flash the wrong layout on screen.
    const isValidLayout = (parsed: { panels?: Record<string, unknown> }, wsId: string): boolean => {
      const isCoreWs = wsId === 'edit' || wsId === 'preview' || wsId === 'workbench';
      if (!isCoreWs && parsed.panels) {
        // Custom workspaces must not have ep:* editor panels — those come from the
        // old buildDefault that used the 'edit' branch for all unknown workspaces.
        if (Object.keys(parsed.panels).some((k) => k.startsWith('ep:'))) return false;
      }
      if (wsId === 'workbench' && !parsed.panels?.['main']) return false;
      return true;
    };

    const tryRestore = (raw: string | null, wsId: string = activeId): boolean => {
      if (!raw) return false;
      try {
        const parsed = JSON.parse(raw) as { panels?: Record<string, unknown> };
        if (!isValidLayout(parsed, wsId)) {
          // Evict the bad layout so it doesn't come back on next load.
          try { localStorage.removeItem(`forgeax:ws-layout:${wsId}`); } catch { /* noop */ }
          return false;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        api.fromJSON(parsed as any);
        const hasViewport = api.getPanel('edit') || api.getPanel('main') || api.getPanel('preview') || api.getPanel('workbench');
        const hasAny = hasViewport || api.getPanel('chat') || api.panels.length > 0;
        if (!hasAny) { api.clear(); return false; }
        return true;
      } catch { try { api.clear(); } catch { /* noop */ } return false; }
    };
    try {
      restored = tryRestore(localStorage.getItem(`forgeax:ws-layout:${activeId}`), activeId);
      if (!restored && activeId === 'edit') {
        // migration: try the old single-layout key
        restored = tryRestore(localStorage.getItem(LS_KEY));
      }
    } catch { restored = false; }
    if (!restored) buildDefault(api, activeId);

    // Sync panel titles to canonical names (code rename doesn't need a key bump).
    for (const [id, title] of Object.entries(PANEL_TITLE)) {
      try { api.getPanel(id)?.api.setTitle(title); } catch { /* noop */ }
    }

    // hideChatAndForge BANDAGE — close any auto-mounted or restored chat panel
    // for standalone hosts. Acts as the final post-processing step so neither
    // buildDefault nor tryRestore needs to know about the flag (plan-strategy
    // section 2 D-4 keeps chat-slice store untouched and routes the opt-out
    // strictly through prop drilling).
    if (hideChatRef.current) {
      try { api.getPanel('chat')?.api.close(); } catch { /* noop */ }
    }
  }, []);

  // Workspace switch subscription — in a useEffect so React properly cleans it
  // up on unmount / HMR remount (prevents stale listeners accumulating).
  useEffect(() => {
    return subscribeWorkspaces(() => {
      const api = apiRef.current;
      if (!api) return;
      const { activeId: newId } = loadWorkspaces();
      if (newId === prevWorkspaceIdRef.current) return;
      saveWorkspaceLayout(prevWorkspaceIdRef.current, api.toJSON());
      prevWorkspaceIdRef.current = newId;
      // The layout is being completely replaced — reset toggle-hidden tracking so
      // sidebar/chat collapse effects start fresh for the new workspace.
      hiddenByToggleRef.current.clear();
      const syncTitles = (): void => {
        for (const [id, title] of Object.entries(PANEL_TITLE)) {
          try { api.getPanel(id)?.api.setTitle(title); } catch { /* noop */ }
        }
      };
      const saved = loadWorkspaceLayout(newId);
      if (saved) {
        try {
          // Validate raw JSON before loading — avoids flashing the wrong layout.
          const isCoreWs = newId === 'edit' || newId === 'preview' || newId === 'workbench';
          const panels = (saved as { panels?: Record<string, unknown> }).panels ?? {};
          const hasStaleEpPanels = !isCoreWs && Object.keys(panels).some((k) => k.startsWith('ep:'));
          const missingMain = newId === 'workbench' && !panels['main'];
          if (hasStaleEpPanels || missingMain) {
            try { localStorage.removeItem(`forgeax:ws-layout:${newId}`); } catch { /* noop */ }
            // fall through to buildDefault
          } else {
            api.fromJSON(saved);
            const anchor = newId === 'preview' ? 'preview' : newId === 'workbench' ? 'main' : null;
            if (!anchor || api.getPanel(anchor)) { syncTitles(); return; }
            // anchor missing — fall through to buildDefault
          }
        } catch { /* fall through */ }
      }
      try { api.clear(); } catch { /* noop */ }
      buildDefault(api, newId);
      syncTitles();
      // hideChatAndForge BANDAGE — re-apply chat closure on workspace switch
      // because buildDefault re-mounts a chat panel for several layouts.
      if (hideChatRef.current) {
        try { api.getPanel('chat')?.api.close(); } catch { /* noop */ }
      }
    });
  }, []);

  // Reset-layout hook — useEffect for proper cleanup on HMR remounts.
  useEffect(() => {
    const onReset = (): void => {
      const api = apiRef.current;
      if (!api) return;
      try {
        api.clear();
        buildDefault(api, loadWorkspaces().activeId);
        // hideChatAndForge BANDAGE — reset-layout rebuilds defaults that may
        // include a chat panel; close it again for standalone hosts.
        if (hideChatRef.current) {
          try { api.getPanel('chat')?.api.close(); } catch { /* noop */ }
        }
      } catch { /* noop */ }
    };
    window.addEventListener(APP_EVENTS.dockReset, onReset);
    return () => { window.removeEventListener(APP_EVENTS.dockReset, onReset); };
  }, []);

  // On mount: load workspace layouts from server into localStorage (only when
  // localStorage is empty for a given workspace — e.g. after clearing browser
  // storage or on a fresh machine). Then apply the active workspace's layout if
  // the dock is ready and localStorage was empty before init.
  useEffect(() => {
    const { activeId } = loadWorkspaces();
    const hadActiveLayout = !!localStorage.getItem(`forgeax:ws-layout:${activeId}`);
    void initWorkspaceLayouts().then(() => {
      if (hadActiveLayout) return; // localStorage already had data — nothing to apply
      const api = apiRef.current;
      if (!api) return;
      const saved = loadWorkspaceLayout(activeId);
      if (!saved) return;
      try { api.fromJSON(saved); } catch { /* fall through — keep current layout */ }
    });
  }, []);

  // Reopen a panel that was closed (× on its tab) so closing one is never a
  // dead end. Re-added to the right of whatever's there.
  const reopen = useCallback((id: string): void => {
    const api = apiRef.current;
    if (!api || api.getPanel(id)) return;
    const ref = api.panels[api.panels.length - 1]?.id;
    const component = id;
    const title = PANEL_TITLE[id] ?? (id.startsWith('wb:') ? id.slice(3) : id.startsWith('ep:') ? id.slice(3) : id);
    api.addPanel({ id, component, title, position: ref ? { referencePanel: ref, direction: 'right' } : undefined });
  }, []);
  // Keep a ref so the drag-end closure (registered once in useEffect) can call
  // the latest `reopen` without needing a deps re-registration.
  reopenRef.current = reopen;

  // Bridge the legacy collapse toggles (TopBar / shortcuts) to the dock.
  // Collapse = close that panel and remember it was hidden by the toggle.
  // Expand = only reopen if it was the toggle that hid it (not the user's own ×).
  // This prevents "close fails" where a manually-closed panel would reopen on toggle.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    const p = api.getPanel('workbench');
    if (sidebarCollapsed) {
      if (p) { hiddenByToggleRef.current.add('workbench'); p.api.close(); }
    } else {
      if (!p && hiddenByToggleRef.current.has('workbench')) {
        hiddenByToggleRef.current.delete('workbench');
        reopen('workbench');
      }
    }
  }, [sidebarCollapsed, reopen]);
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    // hideChatAndForge BANDAGE — short-circuit the chat reopen path so the
    // chat panel does not come back when chatpanelCollapsed flips false.
    // The store slice (chatpanelCollapsed) is intentionally left untouched
    // (plan-strategy section 2 D-4); we only suppress the dock-side echo.
    if (hideChatRef.current) {
      const p = api.getPanel('chat');
      try { p?.api.close(); } catch { /* noop */ }
      return;
    }
    const p = api.getPanel('chat');
    if (chatpanelCollapsed) {
      if (p) { hiddenByToggleRef.current.add('chat'); p.api.close(); }
    } else {
      if (!p && hiddenByToggleRef.current.has('chat')) {
        hiddenByToggleRef.current.delete('chat');
        reopen('chat');
      }
    }
  }, [chatpanelCollapsed, reopen]);

  // Fullscreen (Ctrl+Shift+F / TopBar): collapse to just Main, restoring the
  // side panels that were open when fullscreen exits.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    if (fullscreen) {
      // Snapshot which panels were open so we can restore exactly those on exit.
      preFullscreen.current = { workbench: !!api.getPanel('workbench'), chat: !!api.getPanel('chat') };
      api.getPanel('workbench')?.api.close();
      api.getPanel('chat')?.api.close();
    } else if (preFullscreen.current) {
      // Only restore panels that were open before fullscreen — not ones the user
      // had already closed before entering fullscreen.
      if (preFullscreen.current.workbench && !api.getPanel('workbench')) reopen('workbench');
      if (preFullscreen.current.chat && !api.getPanel('chat')) reopen('chat');
      preFullscreen.current = null;
    }
  }, [fullscreen, reopen]);

  // When a surface-popped panel's OS window closes, bring it back into the dock.
  useEffect(() => {
    return getWindowManager().onSurfaceWindowClosed((d) => {
      if (SURFACE_PANELS.has(d.id)) reopen(d.id);
    });
  }, [reopen]);

  // CRITICAL for docking onto iframe panels (Main = preview/editor iframe, plugin
  // panes): a native drag is SWALLOWED by iframes, so dockview's drop overlay
  // never sees the dragover and you can't dock/merge over the center. While a tab/
  // group is being dragged, disable pointer-events on iframes + panel bodies so
  // the overlay receives the drag; restore on drop/end.
  useEffect(() => {
    // WINDOW-level (not wrap-level): dockview portals FLOATING groups to <body>,
    // outside .fx-dockwrap — a wrap-scoped listener misses their tab dragstart, so
    // dropping a floating window BACK onto an iframe panel fails ("拖出来放不回去").
    // Toggle a class on <html> and kill iframe pointer-events globally during any
    // drag so dockview's drop overlay always wins (parent-window drags are only
    // dockview tab drags, so this is safe).
    const on = (): void => document.documentElement.classList.add('fx-dock-dragging');
    const off = (): void => document.documentElement.classList.remove('fx-dock-dragging');
    // Floating-GROUP moves (dragging the window's tab bar) are POINTER-based, not
    // HTML5 dragstart — so catch pointerdown on the tab bar (`.dv-tabs-and-actions-
    // container`) too, else a floating window can't be merged back over an iframe
    // panel. Native tab drags also begin with this pointerdown; harmless on clicks.
    const onPointerDown = (e: PointerEvent): void => {
      const t = e.target as Element | null;
      if (t && t.closest('.dv-tabs-and-actions-container')) on();
    };
    // Rhino-style: a tab dropped OUTSIDE any dock group (over toolbar / empty /
    // off the tiles) and not handled by dockview → float it there.
    const onDragEnd = (e: DragEvent): void => {
      off();
      const id = draggedIdRef.current;
      draggedIdRef.current = null;
      if (!id) return;
      const x = e.clientX, y = e.clientY;
      const start = dragStartRef.current;
      const moved = Math.hypot(x - start.x, y - start.y);
      setTimeout(() => {
        if (dropHandledRef.current) return;  // dockview docked/merged/split it → not a float
        if (moved < 24) return;              // a click / micro-drag, not a tear-off
        const api = apiRef.current;
        const panel = api?.getPanel(id);
        if (!api || !panel) return;
        // In Tauri: ANY drop NOT handled by dockview (outside the window OR over
        // empty space) → pop the panel to a REAL OS window. This gives a consistent
        // UE/Blender feel: tear off = independent window, no intermediate in-app float.
        if (getWindowManager().canDetach() && (SURFACE_PANELS.has(id) || id.startsWith('ep:'))) {
          const outside =
            e.screenX < window.screenX ||
            e.screenY < window.screenY ||
            e.screenX > window.screenX + window.innerWidth ||
            e.screenY > window.screenY + window.innerHeight;
          // Position near the drop point; offset so the title bar is under the cursor.
          const wx = outside
            ? Math.round(e.screenX - 140)
            : Math.round(window.screenX + x - 140);
          const wy = outside
            ? Math.round(e.screenY - 16)
            : Math.round(window.screenY + y - 16);
          popPanelToWindow(api, id, { x: wx, y: wy }, sceneSlugRef.current, () => reopenRef.current(id));
          return;
        }
        // Browser (no Tauri): do nothing — panel stays docked where it was.
        // (addFloatingGroup caused confusing in-app "free panels"; removed.)
      }, 0);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('dragstart', on, true);
    window.addEventListener('pointerup', off, true);
    window.addEventListener('dragend', onDragEnd, true);
    window.addEventListener('drop', off, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('dragstart', on, true);
      window.removeEventListener('pointerup', off, true);
      window.removeEventListener('dragend', onDragEnd, true);
      window.removeEventListener('drop', off, true);
    };
  }, []);

  return (
    <div className="fx-dockwrap" ref={wrapRef}>
      <DockviewReact
        className="dockview-theme-abyss fx-dockshell"
        components={components}
        onReady={onReady}
        singleTabMode="fullwidth"
        disableFloatingGroups={false}
        // rightHeaderActionsComponent removed — the pop-out ⧉ button was
        // rendering inside the tab strip in a confusing position. Pop-out is
        // still available via drag-to-outside-window (Tauri) or the 布局 menu.
      />
      <LayoutControl apiRef={apiRef} onReopen={reopen} busPlugins={busPlugins} />
    </div>
  );
}

function LayoutControl({ apiRef, onReopen, busPlugins }: { apiRef: React.RefObject<DockviewApi | null>; onReopen: (id: string) => void; busPlugins: BusPluginInfo[] }) {
  const [open, setOpen] = useState(false);
  // Anchor rect of the trigger button (TopBar LayoutGrid icon), passed via the
  // toggle event so the portalled menu lands right under the button.
  const [anchor, setAnchor] = useState<{ top: number; bottom: number; left: number; right: number } | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { rect?: typeof anchor } | undefined;
      if (detail?.rect) setAnchor(detail.rect);
      setOpen((o) => !o);
    };
    window.addEventListener(APP_EVENTS.dockLayoutToggle, handler);
    return () => window.removeEventListener(APP_EVENTS.dockLayoutToggle, handler);
  }, []);
  const api = apiRef.current;
  const isOpen = (id: string): boolean => !!api?.getPanel(id);

  // FloatingMenu owns portal + top-layer z-index + click-outside + Esc, anchored
  // under the TopBar layout button (rect arrives via the toggle event).
  return (
    <FloatingMenu open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" className="fx-dl-menu">
          {/* 重置布局 pinned at the top (sticky) so it's always reachable even
              when the plugin list below is long enough to scroll. */}
          <button type="button" className="fx-dl-item fx-dl-reset" onClick={() => { window.dispatchEvent(new CustomEvent(APP_EVENTS.dockReset)); setOpen(false); }}>
            <RotateCcw size={12} /> 重置布局
          </button>
          <div className="fx-dl-sep" />
          <div className="fx-dl-head">编辑器面板</div>
          {EDITOR_PANEL_IDS.map((id) => {
            const panelId = `ep:${id}`;
            return (
              <button key={panelId} type="button" className={`fx-dl-item${isOpen(panelId) ? ' on' : ''}`}
                onClick={() => { if (isOpen(panelId)) apiRef.current?.getPanel(panelId)?.api.close(); else onReopen(panelId); }}>
                <span className="fx-dl-check">{isOpen(panelId) ? '✓' : '＋'}</span>{EDITOR_PANEL_TITLE[id]}
              </button>
            );
          })}
          <div className="fx-dl-head">主面板</div>
          {PANEL_IDS.map((id) => (
            <button key={id} type="button" className={`fx-dl-item${isOpen(id) ? ' on' : ''}`}
              onClick={() => { if (isOpen(id)) apiRef.current?.getPanel(id)?.api.close(); else onReopen(id); }}>
              <span className="fx-dl-check">{isOpen(id) ? '✓' : ''}</span>{PANEL_TITLE[id]}
            </button>
          ))}
          <div className="fx-dl-head">更多面板</div>
          {OPTIONAL_IDS.map((id) => (
            <button key={id} type="button" className={`fx-dl-item${isOpen(id) ? ' on' : ''}`}
              onClick={() => { if (isOpen(id)) apiRef.current?.getPanel(id)?.api.close(); else onReopen(id); }}>
              <span className="fx-dl-check">{isOpen(id) ? '✓' : '＋'}</span>{PANEL_TITLE[id]}
            </button>
          ))}
          {busPlugins.length > 0 && (
            <>
              <div className="fx-dl-head">插件面板</div>
              {busPlugins.map((p) => {
                const id = `wb:${p.id}`;
                const label = pickLang(p.displayName, 'zh', p.id);
                return (
                  <button key={id} type="button" className={`fx-dl-item${isOpen(id) ? ' on' : ''}`}
                    onClick={() => { if (isOpen(id)) apiRef.current?.getPanel(id)?.api.close(); else onReopen(id); }}>
                    <span className="fx-dl-check">{isOpen(id) ? '✓' : '＋'}</span>{label}
                  </button>
                );
              })}
            </>
          )}
    </FloatingMenu>
  );
}
