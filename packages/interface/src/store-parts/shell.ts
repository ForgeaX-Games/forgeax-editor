import { getWindowManager, surfaceKey, type SurfaceDescriptor } from '../lib/platform';
import type { AppState } from '../store';
import { loadSettingsSection, saveSettingsSection } from './persistence';

type SetAppState = (
  partial: Partial<AppState> | ((state: AppState) => Partial<AppState>),
) => void;
type GetAppState = () => AppState;

export const VIEWPORT_CARRIER_WILL_DETACH = 'forgeax:viewport-carrier-will-detach' as const;

export function createShellState(
  set: SetAppState,
  get: GetAppState,
): Pick<
  AppState,
  | 'floatingSurfaces'
  | 'detachSurface'
  | 'redockSurface'
  | 'markSurfaceDocked'
  | 'activeSession'
  | 'setActiveSession'
  | 'activeOverlay'
  | 'overlayParam'
  | 'openOverlay'
  | 'setOverlayParam'
  | 'closeOverlay'
  | 'gameDirectoryModalOpen'
  | 'openGameDirectoryModal'
  | 'closeGameDirectoryModal'
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
    floatingSurfaces: {},
    detachSurface: async (d: SurfaceDescriptor, opts?: { title?: string; x?: number; y?: number; width?: number; height?: number }) => {
      const wm = getWindowManager();
      if (!wm.canDetach()) return false;
      const key = surfaceKey(d);
      if (d.kind === 'panel' && d.id === 'viewport') {
        window.dispatchEvent(new CustomEvent(VIEWPORT_CARRIER_WILL_DETACH));
      }
      set((s) => ({ floatingSurfaces: { ...s.floatingSurfaces, [key]: true } }));
      const ok = await wm.openSurfaceWindow(d, opts);
      if (!ok) {
        set((s) => {
          const next = { ...s.floatingSurfaces };
          delete next[key];
          return { floatingSurfaces: next };
        });
      }
      return ok;
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

    gameDirectoryModalOpen: false,
    openGameDirectoryModal: () => set({ gameDirectoryModalOpen: true }),
    closeGameDirectoryModal: () => set({ gameDirectoryModalOpen: false }),

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
