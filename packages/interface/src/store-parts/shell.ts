import { getWindowManager, surfaceKey, type SurfaceDescriptor } from '../lib/platform';
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
  | 'workbenchTab'
  | 'setWorkbenchTab'
  | 'workbenchExpandedExtensionId'
  | 'setWorkbenchExpandedExtensionId'
  | 'openWorkbench'
  | 'floatingSurfaces'
  | 'detachSurface'
  | 'redockSurface'
  | 'dockedExtensions'
  | 'addDockedExtension'
  | 'removeDockedExtension'
  | 'markSurfaceDocked'
  | 'activeSession'
  | 'setActiveSession'
  | 'activeOverlay'
  | 'overlayParam'
  | 'openOverlay'
  | 'setOverlayParam'
  | 'closeOverlay'
  | 'projectModalTab'
  | 'openProjectModal'
  | 'closeProjectModal'
  | 'gameSwitcherOpen'
  | 'setGameSwitcherOpen'
  | 'gameModalOpen'
  | 'openGameModal'
  | 'closeGameModal'
  | 'fullscreen'
  | 'setFullscreen'
  | 'toggleFullscreen'
  | 'sidebarCollapsed'
  | 'chatpanelCollapsed'
  | 'toggleSidebar'
  | 'toggleChatpanel'
> {
  return {
    workbenchTab: 'agents',
    setWorkbenchTab: (t) => set({ workbenchTab: t }),
    workbenchExpandedExtensionId: null,
    setWorkbenchExpandedExtensionId: (id) => set({ workbenchExpandedExtensionId: id }),
    openWorkbench: ({ tab, expandedExtensionId }) => set((s) => ({
      workbenchTab: tab ?? s.workbenchTab,
      workbenchExpandedExtensionId: expandedExtensionId !== undefined
        ? expandedExtensionId
        : s.workbenchExpandedExtensionId,
    })),

    dockedExtensions: new Set<string>(),
    addDockedExtension: (id) => set((s) => ({ dockedExtensions: new Set([...s.dockedExtensions, id]) })),
    removeDockedExtension: (id) => set((s) => {
      const next = new Set(s.dockedExtensions);
      next.delete(id);
      return { dockedExtensions: next };
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

    projectModalTab: null,
    openProjectModal: (tab) => set({ projectModalTab: tab }),
    closeProjectModal: () => set({ projectModalTab: null }),

    gameSwitcherOpen: false,
    setGameSwitcherOpen: (v) => set({ gameSwitcherOpen: v }),
    gameModalOpen: false,
    openGameModal: () => set({ gameModalOpen: true }),
    closeGameModal: () => set({ gameModalOpen: false }),

    fullscreen: false,
    setFullscreen: (v) => set({ fullscreen: v }),
    toggleFullscreen: () => set((s) => ({ fullscreen: !s.fullscreen })),

    sidebarCollapsed: false,
    chatpanelCollapsed: false,
    toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    toggleChatpanel: () => set((s) => ({ chatpanelCollapsed: !s.chatpanelCollapsed })),
  };
}
