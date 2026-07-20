/**
 * Global status bar registry — Blender-style bottom strip.
 *
 * Any component can drop an item onto the bar by calling `useStatusBarItem`
 * during render.  The bar slot is fixed (`left` / `center` / `right`); within
 * a slot, items are sorted by descending `priority`.  When the number of items
 * in a slot exceeds the bar's visible capacity, the lowest-priority items
 * carousel through the trailing visible slots on a fixed interval
 * (`CAROUSEL_INTERVAL_MS`).
 *
 * Design rationale:
 *   - External (module-level) store + `useSyncExternalStore` keeps the bar
 *     decoupled from any specific store (zustand, redux, etc.). Anything that
 *     can render React can register a chip.
 *   - We re-`upsert` on every render of the owner; the owner's local state
 *     therefore flows naturally into its `node` payload — no extra
 *     subscriptions, no stale closures.
 *   - We snapshot to a cached array so `useSyncExternalStore` doesn't tear
 *     re-render loops.
 *
 * Add a new chip in 3 lines anywhere in the app:
 *
 *   useStatusBarItem({
 *     id: 'my-chip',
 *     slot: 'left',
 *     priority: 50,
 *     node: <span className="sb-chip">My state · {count}</span>,
 *   });
 */

import { useEffect, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

export type StatusBarSlot = 'left' | 'center' | 'right';

export interface StatusBarItem {
  /** unique key; collisions overwrite (so a re-render simply updates the item). */
  id: string;
  slot: StatusBarSlot;
  /** higher = more permanent, lower = more likely to enter the carousel. */
  priority: number;
  /** the rendered chip itself — usually a tiny `<span>` / `<button>`. */
  node: ReactNode;
}

const items = new Map<string, StatusBarItem>();
let snapshot: StatusBarItem[] = [];
const listeners = new Set<() => void>();

function emit() {
  snapshot = Array.from(items.values());
  for (const fn of listeners) fn();
}

export const statusBarStore = {
  upsert(item: StatusBarItem) {
    items.set(item.id, item);
    emit();
  },
  remove(id: string) {
    if (items.delete(id)) emit();
  },
  getAll(): StatusBarItem[] {
    return snapshot;
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

/**
 * Register a status-bar chip from any component.  Updates the registry on
 * every render of the owner (so changes in the owner's state flow through to
 * the bar without an extra dependency dance) and cleans up on unmount.
 */
export function useStatusBarItem(item: StatusBarItem): void {
  // 2026-05-17 — 之前 upsert 在 render 阶段直接调,emit() 会同步通知所有
  // useSyncExternalStore 订阅者 (GlobalStatusBar),触发 setState while
  // rendering 警告。挪到 useEffect 提交后再 upsert + 卸载时 remove。
  // 无 deps:每次 render 提交后都 upsert 一次,让 owner 的 state 能流到
  // chip node 里 (registry 操作是 Map.set,开销可忽略)。
  useEffect(() => {
    statusBarStore.upsert(item);
  });
  useEffect(() => {
    return () => statusBarStore.remove(item.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);
}

/**
 * React-side getter — pairs `statusBarStore` with `useSyncExternalStore` so
 * the bar can subscribe without tearing. Callers use this to read the
 * canonical item array; the bar itself + any debugging surface (e.g. the
 * planned Bus admin status-bar inventory) can share the same hook.
 */
export function useStatusBarItems(): StatusBarItem[] {
  return useSyncExternalStore(statusBarStore.subscribe, statusBarStore.getAll, statusBarStore.getAll);
}
