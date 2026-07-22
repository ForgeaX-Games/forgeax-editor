import { useSyncExternalStore } from 'react';

let open = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function getCommandPaletteOpen(): boolean { return open; }
export function setCommandPaletteOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  notify();
}
export function toggleCommandPalette(): void { setCommandPaletteOpen(!open); }
export function subscribeCommandPalette(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function useCommandPaletteOpen(): boolean {
  return useSyncExternalStore(subscribeCommandPalette, getCommandPaletteOpen, () => false);
}
