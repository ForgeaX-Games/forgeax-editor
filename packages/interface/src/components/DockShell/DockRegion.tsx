import { useCallback, useEffect, useMemo, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { FloatingMenu } from '../ui/FloatingMenu';
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewHeaderActionsProps, type SerializedDockview } from 'dockview';
import 'dockview/dist/styles/dockview.css';
import { WbExtensionDockPanel } from './WbExtensionDockPanel';
import { RecoveryBoundary } from '../ErrorBoundary';
import { getWindowManager } from '../../lib/platform';
import { useTranslation, getLocale, subscribeLocale, t as panelT } from '@/i18n';
import { listExtensions, pickLang, type ExtensionInfo } from '../../lib/extension-api';
import { useShellStore } from '../../store';
// Panel registry — single declarative source for dockview panels (§C1).
import {
  BASE_PANEL_COMPONENTS,
  BASE_PANEL_TITLE,
  buildEditorPanelComponents,
  CORE_PANEL_IDS as PANEL_IDS,
  OPTIONAL_PANEL_IDS as OPTIONAL_IDS,
  SURFACE_PANEL_IDS as SURFACE_PANELS,
} from './panelRegistry';
import { usePanelRenderers, type PanelDescriptor } from './panelRenderers';
import type { DockRegion as DockRegionId } from './regions';
import { resolveRegion } from './resolveRegion';
import { useActiveWorkbench, useWorkbenchActions } from '../../lib/useWorkbench';
import { registerDockviewApi } from './dockviewRegistry';
import { handleCrossInstanceDrop, type CrossInstanceDropEvent } from './crossInstanceDrop';
import { buildTabContextMenuItems } from './tabContextMenu';
import { AuxBarResizer } from './AuxBarResizer';
import { useAuxBarWidth } from './useAuxBarWidth';
import {
  getCurrentProject,
  loadWorkbenchList,
  loadWorkbenchLayout,
  removeWorkbenchLayout,
  saveWorkbenchLayout,
  subscribeCurrentProject,
  subscribeWorkbenchList,
  initWorkbenchLayouts,
} from '../../lib/workbenches';
import { STORAGE_KEYS } from '../../lib/storageKeys';
import { useHost } from '../../core/app-shell';
import { pingAnchorRelayout } from '../../lib/surfaceAnchors';
import { buildDefault } from './builtinWorkbenches';
import { getDockResetEpoch } from './dockResetEpoch';
import './DockShell.css';

/** Clear chrome collapse + rebuild this region's default dock layout. */
function rebuildRegionDefault(
  api: DockviewApi,
  isMember: (id: string) => boolean,
  layoutOverride: SerializedDockview | undefined,
  hideChat: boolean,
): string {
  useShellStore.setState({
    fullscreen: false,
    sidebarCollapsed: false,
    chatpanelCollapsed: false,
  });
  const activeId = loadWorkbenchList().activeId;
  try {
    api.clear();
    buildDefault(api, activeId, isMember, layoutOverride);
  } catch { /* noop */ }
  if (hideChat) {
    try { api.getPanel('chat')?.api.close(); } catch { /* noop */ }
  }
  return activeId;
}

// DockRegion — the interface shell's window/docking layer, parameterized by a
// `region: DockRegion` prop (design EDITOR-MODE §0.2, chosen lib = dockview).
// One instance today (`<DockRegion region="DockShell" />`) replaces the fixed
// Sidebar | MainArea | ChatPanel 3-pane layout with a real dockable workspace:
// every region is a dockview panel that can be dragged to dock / split / tab /
// float, with the layout persisted to localStorage. TopBar + StatusBar stay as
// fixed chrome (outside the dock tree). Later regions (AuxBar, …) are added by
// rendering additional `<DockRegion region="…" />` instances; panel membership
// is decided per-panel by `resolveRegion(id, desc, panelLocations)`.
//
// Panel taxonomy + the full id/title/group/pop-out table now live in
// ./panelRegistry.tsx — add a panel THERE, not by editing constants here.
//   CORE     — workbench / viewport / chat
//   OPTIONAL — agents / files / console (布局 menu toggles)
//   EDITOR   — ep:* editor sub-panels (in-process React components, single-realm)
//   PLUGINS  — wb:<extensionId> panels merged in at runtime (below)

const LS_KEY = STORAGE_KEYS.legacyDockLayout;  // legacy — only read for migration to workspace layouts

// Re-export so external consumers (WorkbenchSwitcher, tests) don't need to know
// buildDefault lives in builtinWorkbenches.ts.
export { buildDefault };

// Pop a dock panel OUT into a REAL OS window (index.html?surface=panel&id=<id>
// → DetachedSurface, which renders the panel's in-process React component).
// No-op in the browser (canDetach() false) — web users tear off via drag-float.
//
// ep:* editor panels are in-process and intentionally stay docked: DetachedSurface
// has no editor-panel body. Other detachable shell panels use the shared
// DetachedSurface path.
function popPanelToWindow(
  api: DockviewApi,
  id: string,
  titleFor: (id: string) => string,
  pos?: { x: number; y: number },
): void {
  const wm = getWindowManager();
  if (!wm.canDetach()) return;

  if (!SURFACE_PANELS.has(id)) return;
  void wm
    .openSurfaceWindow(
      { kind: 'panel', id },
      { title: titleFor(id), width: 480, height: 680, ...(pos ?? {}) },
    )
    .then((ok) => { if (ok) api.getPanel(id)?.api.close(); });
}

// Per-group header affordance: explicit "pop out to OS window" button, shown
// only in Tauri (#10). Reliable counterpart to drag-tear-off.
function PanelPopoutAction(props: IDockviewHeaderActionsProps): React.ReactNode {
  const { t } = useTranslation();
  if (!getWindowManager().canDetach()) return null;
  const id = props.activePanel?.id;
  if (!id || !SURFACE_PANELS.has(id)) return null;
  return (
    <button
      type="button"
      className="fx-dock-popout"
      title={t('dockShell.popoutToWindow')}
      onClick={() => popPanelToWindow(props.containerApi, id, () => id)}
    >
      ⧉
    </button>
  );
}

export function DockRegion({ region }: { region: DockRegionId }) {
  const host = useHost();
  const renderers = usePanelRenderers();
  const editorPanelIds = renderers.editorPanelIds;
  const hideChatPanel = !renderers.panels?.chat;
  // AuxBar's persisted width — applied as inline style below when region is
  // AuxBar. Hook called UNCONDITIONALLY (per rules-of-hooks) even for other
  // regions; the value is simply unused there.
  const auxBarWidth = useAuxBarWidth((s) => s.width);
  // Panel-descriptor registry (Task 3) + user overrides (Task 2). Combined we
  // can compute which panel ids belong to THIS region. The filter is applied
  // where panel-id iteration happens (layout-menu enumeration); buildDefault
  // stays as-is because Phase 1 only renders the 'DockShell' region.
  const panels = renderers.panels;
  const activeWorkbench = useActiveWorkbench();
  const panelLocations = activeWorkbench?.panelLocations ?? {};
  const { moveTo, resetPanelLocations } = useWorkbenchActions();
  const isMember = useCallback((id: string): boolean => {
    // ep:* ids are host-owned: a persisted layout may not resurrect a panel
    // which is absent from this host's injected editor manifest.
    if (id.startsWith('ep:') && !editorPanelIds.includes(id.slice(3))) return false;
    // No descriptor registered → treat non-editor panels as belonging to the
    // DockShell region (matches the pre-refactor behavior).
    const desc = panels?.[id];
    if (!desc) return region === 'DockShell';
    if (!(desc.when?.() ?? true)) return false;
    return resolveRegion(id, desc, panelLocations) === region;
  }, [editorPanelIds, panels, panelLocations, region]);
  // Mirror isMember into a ref so callbacks registered with [] deps (onReady,
  // subscribeWorkbenchList, reset, openPanel handler) can read the latest predicate
  // without re-binding — descriptor/override changes propagate through the ref.
  // useLayoutEffect (not useEffect): tour reset clears panelLocations then
  // immediately dock-resets; the ref must be fresh before that reset runs.
  const isMemberRef = useRef(isMember);
  useLayoutEffect(() => { isMemberRef.current = isMember; }, [isMember]);
  // After a layout restore (api.fromJSON), close any panel that no longer
  // belongs to THIS region — the saved JSON may include panels the user has
  // since moved via panelLocations overrides.
  const closeStrayPanels = useCallback((api: DockviewApi): void => {
    try {
      api.panels.slice().forEach((panel) => {
        if (!isMemberRef.current(panel.id)) {
          try { panel.api.close(); } catch { /* noop */ }
        }
      });
    } catch { /* noop */ }
  }, []);
  // Mirror `panels` into a ref so onReady / async restore branches (registered
  // once with [] deps to satisfy dockview's contract) can read the latest
  // descriptor titles without re-binding.
  const panelsRef = useRef<Record<string, PanelDescriptor> | undefined>(panels);
  useEffect(() => { panelsRef.current = panels; }, [panels]);
  // The injected editor id list is referenced by once-bound callbacks below;
  // mirror it so workbench switching never uses the initial host snapshot.
  const editorPanelIdsRef = useRef(editorPanelIds);
  useEffect(() => { editorPanelIdsRef.current = editorPanelIds; }, [editorPanelIds]);
  const builtinWorkbenchLayoutsRef = useRef(renderers.builtinWorkbenchLayouts);
  useEffect(() => {
    builtinWorkbenchLayoutsRef.current = renderers.builtinWorkbenchLayouts;
  }, [renderers.builtinWorkbenchLayouts]);
  const titleFor = useCallback((id: string): string => {
    const panelId = id.startsWith('ep:') ? id.slice(3) : id;
    // Locale-reactive tab title: resolve by the panel KEY at call time (module
    // `panelT` reads the CURRENT locale), so re-titling after a language switch
    // yields the new language — titles are NOT baked into the persisted layout.
    // A missing key makes `t` echo the key back, so fall through to the static
    // host-descriptor / interface-base title.
    const key = `dockShell.panelTitles.${panelId}`;
    const localized = panelT(key);
    if (localized !== key) return localized;
    if (id.startsWith('ep:')) return panelsRef.current?.[panelId]?.title ?? panelId;
    return panelsRef.current?.[id]?.title
      ?? BASE_PANEL_TITLE[id]
      ?? (id.startsWith('wb:') ? id.slice(3) : id);
  }, []);
  // localStorage layout-key namespacing. DockShell keeps the original key so
  // existing users' saved layouts survive the rename; other regions get an
  // additional `:${region}` suffix. workspaces.ts helpers (load/save/init) are
  // hardcoded to the DockShell key, so we bypass them for non-DockShell regions.
  const regionRef = useRef<DockRegionId>(region);
  useEffect(() => { regionRef.current = region; }, [region]);
  const layoutKey = useCallback(
    (wsId: string): string => (
      regionRef.current === 'DockShell'
        ? `forgeax:ws-layout:${wsId}`
        : `forgeax:ws-layout:${wsId}:${regionRef.current}`
    ),
    [],
  );
  const apiRef = useRef<DockviewApi | null>(null);
  // Last app.dock.reset epoch this region has applied. Compared to
  // getDockResetEpoch() so a reset requested before onReady still lands once.
  const appliedResetEpochRef = useRef(0);
  // Onready-scoped disposables (registry unregister + dockview event subs).
  // Populated in onReady, drained by the unmount effect below so cross-instance
  // wiring doesn't leak between HMR remounts.
  const onReadyCleanupsRef = useRef<Array<() => void>>([]);
  useEffect(() => {
    return () => {
      const cleanups = onReadyCleanupsRef.current;
      onReadyCleanupsRef.current = [];
      for (const fn of cleanups) { try { fn(); } catch { /* noop */ } }
    };
  }, []);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const draggedIdRef = useRef<string | null>(null);
  const dropHandledRef = useRef(false);
  const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // Keep the reopen callback accessible inside the drag-end closure without
  // re-registering the event listener on every change.
  const reopenRef = useRef<(id: string) => void>(() => {});
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const sidebarCollapsed = useShellStore((s) => s.sidebarCollapsed);
  const chatpanelCollapsed = useShellStore((s) => s.chatpanelCollapsed);
  const fullscreen = useShellStore((s) => s.fullscreen);
  // Mirror chat availability into a ref so onReady (memoised with [] deps to
  // satisfy dockview's once-per-mount contract) and async restore branches
  // can read the latest value without re-binding.
  const hideChatRef = useRef<boolean>(hideChatPanel);
  useEffect(() => { hideChatRef.current = hideChatPanel; }, [hideChatPanel]);
  // Active bus workbench plugins — used to populate the "插件面板" layout section.
  // The plugin bus is owned by `cli` (后L2 Agent engine, /api/bus → getEventBus),
  // NOT by platform-io (后L1). If the host did not inject chat, the standalone
  // shell has no agent engine, so there is never a bus to probe.
  // Skip the fetch entirely in that mode: firing it would guarantee a 404 (red in
  // the console) for a capability standalone intentionally doesn't have. (bus-api
  // still degrades gracefully if it IS hit; this just avoids the pointless wire
  // request — §4 前L2 不连后L2.)
  const [busExtensions, setBusExtensions] = useState<ExtensionInfo[]>([]);
  useEffect(() => {
    if (hideChatPanel) return; // no injected chat/agent engine → no plugin bus
    let cancelled = false;
    void listExtensions('workbench').then((res) => { if (!cancelled) setBusExtensions(res.items ?? []); });
    return () => { cancelled = true; };
  }, [hideChatPanel]);

  // Dynamic components map: interface-owned panels + host-injected editor
  // panels + wb:* plugin renderers. The editor list is deliberately runtime
  // data so interface never carries an editor-business registry.
  const components = useMemo(() => ({
    ...BASE_PANEL_COMPONENTS,
    ...buildEditorPanelComponents(editorPanelIds),
    ...Object.fromEntries(busExtensions.map((p) => [
      `wb:${p.id}`,
      // Region-scoped recovery: a plugin panel crash shows a retry/reload
      // affordance for that panel only, not the whole shell.
      () => (
        <RecoveryBoundary scope={`wb:${p.id}`} fullscreen={false}>
          <WbExtensionDockPanel extensionId={p.id} />
        </RecoveryBoundary>
      ),
    ])),
  }), [busExtensions, editorPanelIds]);
  const preFullscreen = useRef<{ tools: boolean; chat: boolean } | null>(null);
  // Track the workspace id that is currently rendered in the dock so we can
  // save its layout before switching. Lives outside onReady so useEffect cleanup
  // can unsubscribe correctly on HMR remounts.
  const prevWorkspaceIdRef = useRef(loadWorkbenchList().activeId);
  // Track which panels were hidden by the collapse toggle (not by the user clicking ×).
  // Only these panels get reopened when the toggle is expanded again — prevents
  // the "close fails" bug where manually-closed panels came back on sidebar toggle.
  const hiddenByToggleRef = useRef(new Set<string>());

  const onReady = useCallback((event: DockviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__dockApi = api;

    // Cross-instance drag & drop wiring (§P2/T3):
    //  1) Register this DockviewApi in the module-singleton registry so foreign
    //     regions can find + close-the-source-panel when a panel is dropped in.
    //  2) Accept drops originating from OTHER DockviewReact instances — dockview
    //     rejects foreign viewIds by default via its root overlay, so panels
    //     dragged from DockShell → AuxBar (or vice versa) never trigger onDidDrop
    //     without an explicit accept.
    onReadyCleanupsRef.current.push(registerDockviewApi(api));
    const overlaySub = api.onUnhandledDragOverEvent((e) => {
      const t = e.getData?.();
      if (!t) return;
      if (t.viewId === api.id) return; // same-instance, dockview handles natively
      e.accept();
    });
    onReadyCleanupsRef.current.push(() => { try { overlaySub.dispose(); } catch { /* noop */ } });

    // Note: migration is triggered by setCurrentProject() (ProjectSwitcher)
    // and by loadWorkbenchList()/loadWorkbenchLayout() as belt+suspenders,
    // so it has always run by the time we reach onReady. No explicit call
    // needed here.

    // Workspace-aware persistence: save to the current workspace's slot on every change.
    api.onDidLayoutChange(() => {
      saveWorkbenchLayout(prevWorkspaceIdRef.current, api.toJSON());
      bump();
      // Tell the keep-alive surface layer to re-track its anchors — panel
      // resize/drag/close moves the Play/Edit anchor rects the fixed surfaces
      // overlay. (Anchor mount/unmount is handled separately by subscribeAnchors.)
      pingAnchorRelayout();
    });

    api.onWillDragPanel((e) => {
      draggedIdRef.current = e.panel.id;
      dropHandledRef.current = false;
      const ne = e.nativeEvent as { clientX?: number; clientY?: number };
      dragStartRef.current = { x: ne.clientX ?? 0, y: ne.clientY ?? 0 };
    });
    api.onDidDrop(() => { dropHandledRef.current = true; });

    // If app.dock.reset was requested before this region was ready, skip restore
    // and seed the default layout once (same outcome as the reset handler).
    const resetEpoch = getDockResetEpoch();
    if (appliedResetEpochRef.current < resetEpoch) {
      appliedResetEpochRef.current = resetEpoch;
      const activeId = loadWorkbenchList().activeId;
      prevWorkspaceIdRef.current = activeId;
      rebuildRegionDefault(
        api,
        isMemberRef.current,
        builtinWorkbenchLayoutsRef.current?.[activeId],
        hideChatRef.current,
      );
    } else {
      // Restore the active workspace's layout, falling back to legacy LS_KEY for
      // the viewport workspace on first migration, else build the workspace default.
      const { activeId } = loadWorkbenchList();
      prevWorkspaceIdRef.current = activeId;
      let restored = false;
      // isValidLayout — checks the raw serialized JSON BEFORE giving it to dockview.
      // Rejects it early so we never briefly flash the wrong layout on screen.
      const isValidLayout = (parsed: { panels?: Record<string, unknown> }, wsId: string): boolean => {
        const isCoreWs = wsId === 'scene' || wsId === 'ai';
        if (parsed.panels) {
          const panelIds = Object.keys(parsed.panels);
          // Custom workspaces must not have ep:* editor panels — those come from
          // the old buildDefault that used the 'scene' branch for unknown ids.
          if (!isCoreWs && panelIds.some((k) => k.startsWith('ep:'))) return false;
          // A built-in layout may only restore editor panels declared by this host.
          if (isCoreWs && panelIds.some((k) => (
            k.startsWith('ep:') && !editorPanelIdsRef.current.includes(k.slice(3))
          ))) return false;
        }
        if (wsId === 'ai' && !parsed.panels?.['main']) return false;
        return true;
      };

      const tryRestore = (raw: string | null, wsId: string = activeId): boolean => {
        if (!raw) return false;
        try {
          const parsed = JSON.parse(raw) as { panels?: Record<string, unknown> };
          if (!isValidLayout(parsed, wsId)) {
            // Evict the bad layout so it doesn't come back on next load.
            try {
              if (regionRef.current === 'DockShell') {
                removeWorkbenchLayout(wsId);
              } else {
                localStorage.removeItem(layoutKey(wsId));
              }
            } catch { /* noop */ }
            return false;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          api.fromJSON(parsed as any);
          // Drop any restored panels that no longer belong to THIS region
          // (panelLocations overrides may have re-homed them since the save).
          closeStrayPanels(api);
          const hasViewport = api.getPanel('viewport') || api.getPanel('main') || api.getPanel('tools');
          const hasAny = hasViewport || api.getPanel('chat') || api.panels.length > 0;
          if (!hasAny) { api.clear(); return false; }
          return true;
        } catch { try { api.clear(); } catch { /* noop */ } return false; }
      };
      try {
        if (regionRef.current === 'DockShell') {
          const saved = loadWorkbenchLayout(activeId);
          restored = saved ? tryRestore(JSON.stringify(saved), activeId) : false;
          if (!restored && activeId === 'scene') {
            // migration: try the old single-layout key
            restored = tryRestore(localStorage.getItem(LS_KEY));
          }
        } else {
          restored = tryRestore(localStorage.getItem(layoutKey(activeId)), activeId);
        }
      } catch { restored = false; }
      if (!restored) {
        buildDefault(
          api,
          activeId,
          isMemberRef.current,
          builtinWorkbenchLayoutsRef.current?.[activeId],
        );
      }

      // No injected chat surface — close any auto-mounted or restored chat panel
      // for standalone hosts. Acts as the final post-processing step so neither
      // buildDefault nor tryRestore needs to know about the flag (plan-strategy
      // section 2 D-4 keeps chat-slice store untouched and routes the opt-out
      // strictly through prop drilling).
      if (hideChatRef.current) {
        try { api.getPanel('chat')?.api.close(); } catch { /* noop */ }
      }
    }

    // Refresh interface-owned and host-injected panel titles after restoration.
    const titleIds = new Set([
      ...Object.keys(BASE_PANEL_TITLE),
      ...editorPanelIdsRef.current.map((id) => `ep:${id}`),
      ...Object.keys(panelsRef.current ?? {}),
    ]);
    for (const id of titleIds) {
      try { api.getPanel(id)?.api.setTitle(titleFor(id)); } catch { /* noop */ }
    }
  }, []);

  // Reactive reconciliation on panelLocations changes (§P2/T5). When a user
  // calls moveTo (via context menu, drag between regions, or programmatically),
  // panelLocations flips — but dockview holds a snapshot of the layout in its
  // own state. Without this effect the change persists but the panel stays
  // rendered until the next reload. Reconcile in two steps:
  //   1) close any panel currently mounted here whose region ≠ this region
  //   2) reopen any panel whose region now equals this region but isn't
  //      currently rendered (e.g. moved BACK in from AuxBar)
  // Both operations are idempotent and read isMemberRef.current so descriptor
  // + `when` gates are picked up too. No dockReset dispatch — that would
  // rebuild default layout every move and wipe the user's custom arrangement.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    // Close panels that no longer belong here.
    try {
      api.panels.slice().forEach((panel) => {
        if (!isMemberRef.current(panel.id)) {
          try { panel.api.close(); } catch { /* noop */ }
        }
      });
    } catch { /* noop */ }
    // Add panels that now belong here but aren't currently rendered — BUT
    // only when the user EXPLICITLY moved them here (panelLocations[id] ===
    // region). Panels living in their descriptor's default region are seeded
    // by buildDefault at layout construction time; if buildDefault chose NOT
    // to seed a given panel in this workspace (e.g. workbench layout only
    // seeds workbench/main/chat and skips the ep:* editor panels by design),
    // the reactive effect must NOT force-add them — doing so on initial
    // mount dumps every descriptor panel into the current dock split with
    // `direction: 'right'`, collapsing each into a narrow column (regression
    // observed on the AI/workbench workspace).
    const panelsMap = panelsRef.current;
    if (panelsMap) {
      try {
        Object.keys(panelsMap).forEach((id) => {
          if (!isMemberRef.current(id)) return;
          if (api.getPanel(id)) return;
          if (panelLocations[id] !== region) return; // no explicit override → leave to buildDefault
          const ref = api.panels[api.panels.length - 1]?.id;
          try {
            api.addPanel({
              id,
              component: id,
              title: titleFor(id),
              position: ref ? { referencePanel: ref, direction: 'right' } : undefined,
            });
          } catch { /* noop — component may not be registered yet */ }
        });
      } catch { /* noop */ }
    }
  }, [panelLocations, titleFor, region]);

  // Workspace switch subscription — in a useEffect so React properly cleans it
  // up on unmount / HMR remount (prevents stale listeners accumulating).
  useEffect(() => {
    return subscribeWorkbenchList(() => {
      const api = apiRef.current;
      if (!api) return;
      const { activeId: newId } = loadWorkbenchList();
      if (newId === prevWorkspaceIdRef.current) return;
      saveWorkbenchLayout(prevWorkspaceIdRef.current, api.toJSON());
      prevWorkspaceIdRef.current = newId;
      // The layout is being completely replaced — reset toggle-hidden tracking so
      // sidebar/chat collapse effects start fresh for the new workspace.
      hiddenByToggleRef.current.clear();
      const syncTitles = (): void => {
        const titleIds = new Set([
          ...Object.keys(BASE_PANEL_TITLE),
          ...editorPanelIdsRef.current.map((id) => `ep:${id}`),
          ...Object.keys(panelsRef.current ?? {}),
        ]);
        for (const id of titleIds) {
          try { api.getPanel(id)?.api.setTitle(titleFor(id)); } catch { /* noop */ }
        }
      };
      const saved = loadWorkbenchLayout(newId);
      if (saved) {
        try {
          // Validate raw JSON before loading — avoids flashing the wrong layout.
          const isCoreWs = newId === 'scene' || newId === 'ai';
          const savedPanels = (saved as { panels?: Record<string, unknown> }).panels ?? {};
          const savedPanelIds = Object.keys(savedPanels);
          const hasStaleEpPanels = !isCoreWs
            ? savedPanelIds.some((k) => k.startsWith('ep:'))
            : savedPanelIds.some((k) => (
              k.startsWith('ep:') && !editorPanelIdsRef.current.includes(k.slice(3))
            ));
          const missingMain = newId === 'ai' && !savedPanels['main'];
          if (hasStaleEpPanels || missingMain) {
            try { removeWorkbenchLayout(newId); } catch { /* noop */ }
            // fall through to buildDefault
          } else {
            api.fromJSON(saved);
            // Drop restored panels that no longer belong to THIS region.
            closeStrayPanels(api);
            const anchor = newId === 'ai' ? 'main' : null;
          if (!anchor || api.getPanel(anchor)) { syncTitles(); return; }
            // anchor missing — fall through to buildDefault
          }
        } catch { /* fall through */ }
      }
      try { api.clear(); } catch { /* noop */ }
      buildDefault(
        api,
        newId,
        isMemberRef.current,
        builtinWorkbenchLayoutsRef.current?.[newId],
      );
      syncTitles();
      // No injected chat surface — re-apply chat closure on workspace switch
      // because buildDefault re-mounts a chat panel for several layouts.
      if (hideChatRef.current) {
        try { api.getPanel('chat')?.api.close(); } catch { /* noop */ }
      }
    });
  }, []);

  // Re-title every live panel when the language changes. dockview stores each
  // tab's title imperatively (set at restore/build time), so a locale switch
  // would otherwise leave stale titles until a layout reset. titleFor resolves
  // the CURRENT locale at call time, so re-applying it here is all that's needed
  // — no reload, no persisted-title dependency.
  useEffect(() => {
    return subscribeLocale(() => {
      const api = apiRef.current;
      if (!api) return;
      const titleIds = new Set([
        ...Object.keys(BASE_PANEL_TITLE),
        ...editorPanelIdsRef.current.map((id) => `ep:${id}`),
        ...Object.keys(panelsRef.current ?? {}),
      ]);
      for (const id of titleIds) {
        try { api.getPanel(id)?.api.setTitle(titleFor(id)); } catch { /* noop */ }
      }
    });
  }, [titleFor]);

  // Reset-layout hook — useLayoutEffect so a tour reset emitted in useEffect
  // (after all layout effects) still finds a subscribed listener.
  useLayoutEffect(() => {
    const onReset = (): void => {
      const api = apiRef.current;
      const epoch = getDockResetEpoch();
      // No api yet — onReady will see appliedResetEpochRef < epoch and seed default.
      if (!api) return;
      if (appliedResetEpochRef.current >= epoch) return;
      appliedResetEpochRef.current = epoch;
      const activeId = loadWorkbenchList().activeId;
      rebuildRegionDefault(
        api,
        isMemberRef.current,
        builtinWorkbenchLayoutsRef.current?.[activeId],
        hideChatRef.current,
      );
    };
    return host.bus.on('dock:reset', onReset);
  }, [host]);

  // Open (or focus, if already open) an arbitrary dock panel by id — used by the
  // bottom HealthStatusBar peek to surface the Info panel. Reuses `reopen` (via
  // ref so this listener registers once) for the "not open yet" case.
  useEffect(() => {
    return host.bus.on('panel:open', (payload) => {
      const id = payload.id;
      if (!id) return;
      // Region-scoped: another region owns this panel — let its DockRegion open it.
      if (!isMemberRef.current(id)) return;
      const api = apiRef.current;
      if (!api) return;
      const existing = api.getPanel(id);
      if (existing) { try { existing.api.setActive(); } catch { /* noop */ } return; }
      reopenRef.current?.(id);
      try { apiRef.current?.getPanel(id)?.api.setActive(); } catch { /* noop */ }
    });
  }, [host]);

  // Focus-only: bring a panel to front IF it already exists in the layout. Unlike
  // openPanel this never reopens / force-inserts a closed tab — used by the editor
  // "double-click a mesh → Mesh tab" flow so a user who closed the Mesh panel
  // keeps their layout. Design: docs/design/editor-mesh-panel-ue58-parity.md §7.1.
  useEffect(() => {
    return host.bus.on('panel:focus', (payload) => {
      const id = payload.id;
      if (!id) return;
      try { apiRef.current?.getPanel(id)?.api.setActive(); } catch { /* noop */ }
    });
  }, [host]);

  // On mount: load workspace layouts from server into localStorage (only when
  // localStorage is empty for a given workspace — e.g. after clearing browser
  // storage or on a fresh machine). Then apply the active workspace's layout if
  // the dock is ready and localStorage was empty before init.
  useEffect(() => {
    const { activeId } = loadWorkbenchList();
    const hadActiveLayout = region === 'DockShell'
      ? !!loadWorkbenchLayout(activeId)
      : !!localStorage.getItem(layoutKey(activeId));
    void initWorkbenchLayouts(new Set(editorPanelIds)).then(() => {
      if (hadActiveLayout) return; // localStorage already had data — nothing to apply
      // Tour/layout reset already seeded the default — don't rehydrate a stale
      // project-scoped / server layout over it.
      if (appliedResetEpochRef.current > 0) return;
      const api = apiRef.current;
      if (!api) return;
      const saved = loadWorkbenchLayout(activeId);
      if (!saved) return;
      try {
        api.fromJSON(saved);
        // Drop restored panels that no longer belong to THIS region.
        closeStrayPanels(api);
      } catch { /* fall through — keep current layout */ }
    });
  }, [closeStrayPanels, editorPanelIds, layoutKey, region]);

  // Re-apply the active workspace layout when the project id becomes known
  // after boot (belt+suspenders for the early-bootstrap path in main.tsx).
  const prevProjectIdRef = useRef(getCurrentProject());
  useEffect(() => {
    if (region !== 'DockShell') return;
    return subscribeCurrentProject((projId) => {
      if (projId === prevProjectIdRef.current) return;
      prevProjectIdRef.current = projId;
      const api = apiRef.current;
      if (!api) return;
      const { activeId } = loadWorkbenchList();
      const saved = loadWorkbenchLayout(activeId);
      if (!saved) return;
      try {
        api.fromJSON(saved);
        closeStrayPanels(api);
      } catch { /* noop */ }
    });
  }, [closeStrayPanels, region]);

  // Reopen a panel that was closed (× on its tab) so closing one is never a
  // dead end. Re-added to the right of whatever's there.
  const reopen = useCallback((id: string): void => {
    const api = apiRef.current;
    if (!api || api.getPanel(id)) return;
    // Region-scoped: refuse to reopen a panel that doesn't belong here.
    if (!isMemberRef.current(id)) return;
    const ref = api.panels[api.panels.length - 1]?.id;
    const component = id;
    const title = titleFor(id);
    api.addPanel({ id, component, title, position: ref ? { referencePanel: ref, direction: 'right' } : undefined });
  }, [titleFor]);
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
    const p = api.getPanel('tools');
    if (sidebarCollapsed) {
      if (p) { hiddenByToggleRef.current.add('tools'); p.api.close(); }
    } else {
      if (!p && hiddenByToggleRef.current.has('tools')) {
        hiddenByToggleRef.current.delete('tools');
        reopen('tools');
      }
    }
  }, [sidebarCollapsed, reopen]);
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    // No injected chat surface — short-circuit the chat reopen path so the
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
      preFullscreen.current = { tools: !!api.getPanel('tools'), chat: !!api.getPanel('chat') };
      api.getPanel('tools')?.api.close();
      api.getPanel('chat')?.api.close();
    } else if (preFullscreen.current) {
      // Only restore panels that were open before fullscreen — not ones the user
      // had already closed before entering fullscreen.
      if (preFullscreen.current.tools && !api.getPanel('tools')) reopen('tools');
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
    // Only flag a drag as a DOCKVIEW tab/group drag when it originates in a tab
    // strip. In-panel HTML5 drags (e.g. Hierarchy entity rows being re-parented)
    // must NOT set fx-dock-dragging, or the CSS above would kill pointer-events on
    // the very drop targets that drag needs (the tree rows). Tab drags always
    // start inside `.dv-tabs-and-actions-container` (same anchor as onPointerDown).
    const onDragStart = (e: DragEvent): void => {
      const t = e.target as Element | null;
      if (t && t.closest('.dv-tabs-and-actions-container')) on();
    };
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
        // ep:* editor panels are NOT tear-off targets: DetachedSurface has no editor-
        // panel body, so they stay docked in the single realm.
        if (getWindowManager().canDetach() && SURFACE_PANELS.has(id)) {
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
          popPanelToWindow(api, id, titleFor, { x: wx, y: wy });
          return;
        }
        // Browser (no Tauri): do nothing — panel stays docked where it was.
        // (addFloatingGroup caused confusing in-app "free panels"; removed.)
      }, 0);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('dragstart', onDragStart, true);
    window.addEventListener('pointerup', off, true);
    window.addEventListener('dragend', onDragEnd, true);
    window.addEventListener('drop', off, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('dragstart', onDragStart, true);
      window.removeEventListener('pointerup', off, true);
      window.removeEventListener('dragend', onDragEnd, true);
      window.removeEventListener('drop', off, true);
    };
  }, []);

  // Auto-hide the region when it has zero eligible panels. Avoids showing a
  // visually-empty column; the region reappears the moment a panel is moved in
  // (panelLocations override re-runs isMember, so memberCount jumps to > 0).
  // EXCEPTION: DockShell (the primary dock) NEVER auto-hides — even if every
  // panel has been re-homed to AuxBar it must remain as the layout anchor.
  // Placed AFTER all hook calls so React's rules-of-hooks ordering is preserved;
  // returning null before <DockviewReact/> mounts skips buildDefault/onReady
  // entirely, which is the desired behavior for an empty region. Uses
  // `isMember` (this render's closure) rather than `isMemberRef.current` (which
  // still points at the previous render's closure until the sync effect fires)
  // so the guard reacts to panels/panelLocations changes without a one-frame lag.
  const memberCount = Object.keys(renderers.panels ?? {}).filter(isMember).length;
  if (region !== 'DockShell' && memberCount === 0) return null;

  return (
    <div
      className={`fx-dockwrap fx-dockregion fx-dockregion-${region}`}
      ref={wrapRef}
      data-fx-slot={region}
      style={region === 'AuxBar' ? { width: auxBarWidth } : undefined}
    >
      {region === 'AuxBar' && <AuxBarResizer />}
      <DockviewReact
        className="dockview-theme-abyss fx-dockshell"
        components={components}
        onReady={onReady}
        disableFloatingGroups={false}
        // Cross-instance drag & drop (§P2/T3): dockview 6.6.1 doesn't auto-move
        // panels between DockviewComponent instances. We reconcile imperatively —
        // close on source, add on target, then persist via moveTo(). Same-instance
        // drops early-return inside the helper (dockview already reconciled).
        onDidDrop={(evt) => {
          handleCrossInstanceDrop(
            evt as unknown as CrossInstanceDropEvent,
            region,
            (id, r) => moveTo(id, r),
            { titleFor },
          );
        }}
        // Right-click a tab → context menu with "Move Panel To…" (§P2/T4).
        // dockview 6.6.1 exposes `getTabContextMenuItems` as a first-class prop
        // on <DockviewReact/>; we return a mix of built-in ids ('close',
        // 'closeOthers', 'separator') and custom `{ label, action }` items.
        // See ./tabContextMenu.ts for the pure builder + tests.
        getTabContextMenuItems={(params: { panel: { id: string } }) =>
          buildTabContextMenuItems(
            region,
            params.panel.id,
            (id, r) => moveTo(id, r),
          )
        }
        // rightHeaderActionsComponent removed — the pop-out ⧉ button was
        // rendering inside the tab strip in a confusing position. Pop-out is
        // still available via drag-to-outside-window (Tauri) or the 布局 menu.
      />
      <LayoutControl
        apiRef={apiRef}
        onReopen={reopen}
        busExtensions={busExtensions}
        isMember={isMember}
        editorPanelIds={editorPanelIds}
        titleFor={titleFor}
      />
    </div>
  );
}

function LayoutControl({
  apiRef,
  onReopen,
  busExtensions,
  isMember,
  editorPanelIds,
  titleFor,
}: {
  apiRef: React.RefObject<DockviewApi | null>;
  onReopen: (id: string) => void;
  busExtensions: ExtensionInfo[];
  isMember: (id: string) => boolean;
  editorPanelIds: readonly string[];
  titleFor: (id: string) => string;
}) {
  const host = useHost();
  const { t } = useTranslation();
  const { resetPanelLocations } = useWorkbenchActions();
  const [open, setOpen] = useState(false);
  // Anchor rect of the trigger button (TopBar LayoutGrid icon), passed via the
  // toggle event so the portalled menu lands right under the button.
  const [anchor, setAnchor] = useState<{ top: number; bottom: number; left: number; right: number } | null>(null);
  useEffect(() => {
    return host.bus.on('dock:layout-toggle', (payload) => {
      if (payload.rect) setAnchor(payload.rect);
      setOpen((o) => !o);
    });
  }, [host]);
  const api = apiRef.current;
  const isOpen = (id: string): boolean => !!api?.getPanel(id);

  // FloatingMenu owns portal + top-layer z-index + click-outside + Esc, anchored
  // under the TopBar layout button (rect arrives via the toggle event).
  return (
    <FloatingMenu open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" className="fx-dl-menu">
          {/* 重置布局 pinned at the top (sticky) so it's always reachable even
              when the plugin list below is long enough to scroll. */}
          <button type="button" className="fx-dl-item fx-dl-reset" onClick={() => { void host.commands.execute('app.dock.reset'); setOpen(false); }}>
            <RotateCcw size={12} /> {t('dockShell.resetLayout')}
          </button>
          <div className="fx-dl-sep" />
          <div className="fx-dl-head">{t('dockShell.editorPanels')}</div>
          {editorPanelIds.filter((id) => isMember(`ep:${id}`)).map((id) => {
            const panelId = `ep:${id}`;
            return (
              <button key={panelId} type="button" className={`fx-dl-item${isOpen(panelId) ? ' on' : ''}`}
                onClick={() => { if (isOpen(panelId)) apiRef.current?.getPanel(panelId)?.api.close(); else onReopen(panelId); }}>
                <span className="fx-dl-check">{isOpen(panelId) ? '✓' : '＋'}</span>{titleFor(panelId)}
              </button>
            );
          })}
          <div className="fx-dl-head">{t('dockShell.mainPanels')}</div>
          {PANEL_IDS.filter(isMember).map((id) => (
            <button key={id} type="button" className={`fx-dl-item${isOpen(id) ? ' on' : ''}`}
              onClick={() => { if (isOpen(id)) apiRef.current?.getPanel(id)?.api.close(); else onReopen(id); }}>
              <span className="fx-dl-check">{isOpen(id) ? '✓' : ''}</span>{titleFor(id)}
            </button>
          ))}
          <div className="fx-dl-head">{t('dockShell.morePanels')}</div>
          {OPTIONAL_IDS.filter(isMember).map((id) => (
            <button key={id} type="button" className={`fx-dl-item${isOpen(id) ? ' on' : ''}`}
              onClick={() => { if (isOpen(id)) apiRef.current?.getPanel(id)?.api.close(); else onReopen(id); }}>
              <span className="fx-dl-check">{isOpen(id) ? '✓' : '＋'}</span>{titleFor(id)}
            </button>
          ))}
          {busExtensions.length > 0 && (
            <>
              <div className="fx-dl-head">{t('dockShell.extensionPanels')}</div>
              {busExtensions.filter((p) => isMember(`wb:${p.id}`)).map((p) => {
                const id = `wb:${p.id}`;
                const label = pickLang(p.displayName, getLocale(), p.id);
                return (
                  <button key={id} type="button" className={`fx-dl-item${isOpen(id) ? ' on' : ''}`}
                    onClick={() => { if (isOpen(id)) apiRef.current?.getPanel(id)?.api.close(); else onReopen(id); }}>
                    <span className="fx-dl-check">{isOpen(id) ? '✓' : '＋'}</span>{label}
                  </button>
                );
              })}
            </>
          )}
          {/* Reset panel positions (§P2/T5) — clears user panelLocations
              overrides then dispatches dockReset so the DockRegion effect
              rebuilds the default layout from scratch. Separated from the
              toggle sections above by a visual header so it doesn't get
              tapped by accident. */}
          <div className="fx-dl-sep" />
          <div className="fx-dl-head">{t('dockShell.reset')}</div>
          <button
            type="button"
            className="fx-dl-item"
            onClick={() => {
              resetPanelLocations();
              void host.commands.execute('app.dock.reset');
              setOpen(false);
            }}
          >
            <RotateCcw size={12} /> {t('dockShell.resetPositions')}
          </button>
    </FloatingMenu>
  );
}
