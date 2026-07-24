// Chat column rendered width, persisted across reloads. Chat was pulled out of
// the dockview into a fixed shell column (right of the ActivityRail); this store
// restores its drag-to-resize width. Mirrors useAuxBarWidth. Clamped so a rogue
// setWidth can't collapse the column or eat the whole viewport.
import { create } from 'zustand';

const STORAGE_KEY = 'forgeax:chat-width';
export const CHAT_MIN_WIDTH = 280;
export const CHAT_MAX_WIDTH = 720;
export const CHAT_DEFAULT_WIDTH = 360;

function clamp(n: number): number {
  if (n < CHAT_MIN_WIDTH) return CHAT_MIN_WIDTH;
  if (n > CHAT_MAX_WIDTH) return CHAT_MAX_WIDTH;
  return n;
}
function loadPersisted(): number {
  try {
    if (typeof localStorage === 'undefined') return CHAT_DEFAULT_WIDTH;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return CHAT_DEFAULT_WIDTH;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return CHAT_DEFAULT_WIDTH;
    return clamp(n);
  } catch { return CHAT_DEFAULT_WIDTH; }
}
function persist(width: number): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, String(width));
  } catch { /* private mode / storage disabled */ }
}

interface ChatWidthStore {
  width: number;
  setWidth: (px: number) => void;
}

export const useChatWidth = create<ChatWidthStore>((set) => ({
  width: loadPersisted(),
  setWidth: (px) => {
    const w = clamp(Math.round(px));
    persist(w);
    set({ width: w });
  },
}));
