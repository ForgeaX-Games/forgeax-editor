import { getWindowManager, surfaceKey, type SurfaceDescriptor } from '../lib/platform';
import { bootAppMode } from '../lib/workbenches';
import type { AppState } from '../store';
import { loadSettingsSection, saveSettingsSection } from './persistence';

type SetAppState = (
  partial: Partial<AppState> | ((state: AppState) => Partial<AppState>),
) => void;
type GetAppState = () => AppState;

export function createShellState(
  set: SetAppState,
  get: GetAppState,
): Pick<
  AppState,
  | 'mode'
  | 'setMode'
  | 'workbenchTab'
  | 'setWorkbenchTab'
  | 'workbenchExpandedPluginId'
  | 'setWorkbenchExpandedPluginId'
  | 'openWorkbench'
  | 'floatingSurfaces'
  | 'detachSurface'
  | 'redockSurface'
  | 'dockedPlugins'
  | 'addDockedPlugin'
  | 'removeDockedPlugin'
  | 'markSurfaceDocked'
  | 'activeSession'
  | 'setActiveSession'
  | 'activeOverlay'
  | 'overlayParam'
  | 'openOverlay'
  | 'setOverlayParam'
  | 'closeOverlay'
  | 'fullscreen'
  | 'setFullscreen'
  | 'toggleFullscreen'
  | 'sidebarCollapsed'
  | 'chatpanelCollapsed'
  | 'toggleSidebar'
  | 'toggleChatpanel'
> {
  return {
    mode: bootAppMode(),
    setMode: (m) => set({ mode: m }),
    workbenchTab: 'agents',
    setWorkbenchTab: (t) => set({ workbenchTab: t }),
    workbenchExpandedPluginId: null,
    setWorkbenchExpandedPluginId: (id) => set({ workbenchExpandedPluginId: id }),
    openWorkbench: ({ tab, expandedPluginId }) => set((s) => ({
      mode: 'ai',
      workbenchTab: tab ?? s.workbenchTab,
      workbenchExpandedPluginId: expandedPluginId !== undefined
        ? expandedPluginId
        : s.workbenchExpandedPluginId,
    })),

    dockedPlugins: new Set<string>(),
    addDockedPlugin: (id) => set((s) => ({ dockedPlugins: new Set([...s.dockedPlugins, id]) })),
    removeDockedPlugin: (id) => set((s) => {
      const next = new Set(s.dockedPlugins);
      next.delete(id);
      return { dockedPlugins: next };
    }),

    floatingSurfaces: {},
    detachSurface: async (d: SurfaceDescriptor, opts?: { title?: string }) => {
      const wm = getWindowManager();
      if (!wm.canDetach()) return;
      const key = surfaceKey(d);
      set((s) => ({ floatingSurfaces: { ...s.floatingSurfaces, [key]: true } }));
      const ok = await wm.openSurfaceWindow(d, { title: opts?.title });
      if (!ok) {
        set((s) => {
          const next = { ...s.floatingSurfaces };
          delete next[key];
          return { floatingSurfaces: next };
        });
      }
    },
    redockSurface: async (d: SurfaceDescriptor) => {
      const wm = getWindowManager();
      await wm.closeSurfaceWindow(d);
      get().markSurfaceDocked(surfaceKey(d));
    },
    markSurfaceDocked: (key) => set((s) => {
      if (!s.floatingSurfaces[key]) return {};
      const next = { ...s.floatingSurfaces };
      delete next[key];
      return { floatingSurfaces: next };
    }),

    activeSession: 'main-design',
    setActiveSession: (s) => set({ activeSession: s }),

    activeOverlay: null,
    overlayParam: loadSettingsSection(),
    openOverlay: (id, param) => {
      const p = param ?? get().overlayParam ?? null;
      saveSettingsSection(p);
      set({ activeOverlay: id, overlayParam: p });
    },
    setOverlayParam: (param) => {
      saveSettingsSection(param);
      set({ overlayParam: param });
    },
    closeOverlay: () => set({ activeOverlay: null }),

    fullscreen: false,
    setFullscreen: (v) => set({ fullscreen: v }),
    toggleFullscreen: () => set((s) => ({ fullscreen: !s.fullscreen })),

    sidebarCollapsed: false,
    chatpanelCollapsed: false,
    toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    toggleChatpanel: () => set((s) => ({ chatpanelCollapsed: !s.chatpanelCollapsed })),
  };
}
