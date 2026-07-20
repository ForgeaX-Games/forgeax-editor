// packages/interface/src/lib/useWorkbench.ts
//
// React hooks over the workbench list (workbenches.ts). T6: replaces the
// global useLayoutStore — panelLocations now lives per-workbench inside each
// Workbench record.
//
//   useWorkbenchList()      → current Workbench[] (subscribes to changes)
//   useActiveWorkbench()    → current active Workbench | null
//   useWorkbenchActions()   → { moveTo, resetPanelLocations }
//
// Actions mutate ONLY the active workbench; sibling workbenches keep their
// own panelLocations map untouched (per-workbench isolation).
import { useCallback, useSyncExternalStore } from 'react';
import type { DockRegion } from '../components/DockShell/regions';
import type { Workbench, WorkbenchListState } from './workbenches';
import {
  getWorkbenchListSnapshot,
  loadWorkbenchList,
  saveWorkbenchList,
  subscribeWorkbenchList,
} from './workbenches';

export function useWorkbenchList(): Workbench[] {
  return useSyncExternalStore(subscribeWorkbenchList, () => getWorkbenchListSnapshot().list);
}

export function useActiveWorkbench(): Workbench | null {
  return useSyncExternalStore(subscribeWorkbenchList, () => {
    const state = getWorkbenchListSnapshot();
    return state.list.find((w) => w.id === state.activeId) ?? null;
  });
}

/** Mutate the currently active workbench and persist. No-op when no active. */
function updateActive(fn: (w: Workbench) => Workbench): void {
  const state = loadWorkbenchList();
  const idx = state.list.findIndex((w) => w.id === state.activeId);
  if (idx === -1) return;
  const next: WorkbenchListState = {
    ...state,
    list: state.list.map((w, i) => (i === idx ? fn(w) : w)),
  };
  saveWorkbenchList(next);
}

export interface WorkbenchActions {
  /** Move a panel to a specific dock region. Persists per-active-workbench. */
  moveTo: (panelId: string, region: DockRegion) => void;
  /** Clear panelLocations on the active workbench only. */
  resetPanelLocations: () => void;
}

/** Clear panelLocations on the active workbench only (sync, non-React). */
export function resetActivePanelLocations(): void {
  updateActive((w) => ({ ...w, panelLocations: {} }));
}

export function useWorkbenchActions(): WorkbenchActions {
  const moveTo = useCallback((panelId: string, region: DockRegion) => {
    updateActive((w) => ({
      ...w,
      panelLocations: { ...w.panelLocations, [panelId]: region },
    }));
  }, []);

  const resetPanelLocations = useCallback(() => {
    resetActivePanelLocations();
  }, []);

  return { moveTo, resetPanelLocations };
}
