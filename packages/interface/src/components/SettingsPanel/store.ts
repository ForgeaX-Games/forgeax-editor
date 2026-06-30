/**
 * Settings panel sections registry — mirrors `StatusBar/store.ts`.
 *
 * Any feature can drop a section into the panel by mounting a
 * `useSettingsSection({...})` hook somewhere in the React tree.  No need to
 * edit SettingsPanel.tsx when adding new sections — same plugin-friendly
 * pattern the status bar uses for chips.
 *
 *   id          unique key (also the nav route); collisions overwrite.
 *   label       short i18n label rendered in the left nav.
 *   description optional one-liner shown under the label on the active row.
 *   icon        optional lucide icon component reference.
 *   priority    higher floats up in the nav; sections without explicit
 *               priority default to 50.
 *   group       optional sub-heading the nav can render between rows
 *               ('config' | 'system' | 'plugin' | 'account' …).
 *   node        the actual section body — full React subtree.
 */

import { useEffect, useSyncExternalStore } from 'react';
import type { ComponentType, ReactNode } from 'react';
import type { LucideProps } from 'lucide-react';

export type SettingsGroup = 'config' | 'system' | 'plugin' | 'account' | 'about' | 'other';

export interface SettingsSection {
  id: string;
  label: string;
  description?: string;
  icon?: ComponentType<LucideProps>;
  priority: number;
  group?: SettingsGroup;
  node: ReactNode;
}

const sections = new Map<string, SettingsSection>();
let snapshot: SettingsSection[] = [];
const listeners = new Set<() => void>();

function emit() {
  snapshot = Array.from(sections.values());
  for (const fn of listeners) fn();
}

export const settingsSectionStore = {
  upsert(s: SettingsSection) {
    sections.set(s.id, s);
    emit();
  },
  remove(id: string) {
    if (sections.delete(id)) emit();
  },
  getAll(): SettingsSection[] {
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
 * Register a settings section.  Upserts on every render so the owner's local
 * state flows into `node` without an extra dependency, removes on unmount.
 *
 *   useSettingsSection({
 *     id: 'plugins',
 *     label: 'Plugins',
 *     priority: 70,
 *     group: 'plugin',
 *     node: <BusAdminPanel />,
 *   });
 */
export function useSettingsSection(s: SettingsSection): void {
  // 2026-05-17 — 同 StatusBar/store.ts:同名 fix。render 阶段 upsert 会引发
  // SettingsPanel "setState while rendering" 警告,挪到 useEffect 提交后调。
  useEffect(() => {
    settingsSectionStore.upsert(s);
  });
  useEffect(() => {
    return () => settingsSectionStore.remove(s.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.id]);
}

export function useSettingsSections(): SettingsSection[] {
  return useSyncExternalStore(
    settingsSectionStore.subscribe,
    settingsSectionStore.getAll,
    settingsSectionStore.getAll,
  );
}
