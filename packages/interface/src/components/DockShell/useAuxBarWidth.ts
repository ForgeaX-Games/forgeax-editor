// AuxBar's rendered width, persisted across reloads. Consumed by DockRegion
// (applies as inline style) and AuxBarResizer (writes new width on drag).
// Clamps to a UX-safe range so a rogue setWidth call can't collapse the
// AuxBar to invisible or push it past the primary content.
import { create } from 'zustand';

const STORAGE_KEY = 'forgeax:auxbar-width';
export const AUXBAR_MIN_WIDTH = 200;
export const AUXBAR_MAX_WIDTH = 640;
export const AUXBAR_DEFAULT_WIDTH = 280;

function loadPersisted(): number {
  try {
    if (typeof localStorage === 'undefined') return AUXBAR_DEFAULT_WIDTH;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return AUXBAR_DEFAULT_WIDTH;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return AUXBAR_DEFAULT_WIDTH;
    return clamp(n);
  } catch { return AUXBAR_DEFAULT_WIDTH; }
}
function persist(width: number): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, String(width));
  } catch { /* private mode / storage disabled */ }
}
function clamp(n: number): number {
  if (n < AUXBAR_MIN_WIDTH) return AUXBAR_MIN_WIDTH;
  if (n > AUXBAR_MAX_WIDTH) return AUXBAR_MAX_WIDTH;
  return n;
}

interface AuxBarWidthStore {
  width: number;
  setWidth: (px: number) => void;
}

export const useAuxBarWidth = create<AuxBarWidthStore>((set) => ({
  width: loadPersisted(),
  setWidth: (px) => {
    const w = clamp(Math.round(px));
    persist(w);
    set({ width: w });
  },
}));

// Test-only escape hatch. Bun caches modules across `it` blocks, so the zustand
// initializer runs exactly once per test process — tests that swap localStorage
// state between assertions need to re-derive width from storage explicitly.
// Not part of the public API; do not use outside tests.
export const __loadPersistedForTests = loadPersisted;
