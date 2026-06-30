/**
 * SettingsPanel — fullscreen floating overlay, modeled after Dashboard.
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  Settings                                       [Esc / ✕]    │
 *   ├──────────────┬───────────────────────────────────────────────┤
 *   │  CONFIG      │                                               │
 *   │  · API Keys  │                                               │
 *   │  · Models    │     <ActiveSection.node>                      │
 *   │  · CLI       │                                               │
 *   │  PLUGIN      │                                               │
 *   │  · Plugins   │                                               │
 *   │  SYSTEM      │                                               │
 *   │  · Workspace │                                               │
 *   │  ABOUT       │                                               │
 *   │  · Account   │                                               │
 *   │  · About     │                                               │
 *   └──────────────┴───────────────────────────────────────────────┘
 *
 * - Sections come from `useSettingsSection({...})` callers (registry-driven).
 * - Open/close + active section live in zustand store (so any deep-link can
 *   `openSettings('plugins')` from anywhere).
 * - z-index 1500 (above Dashboard's 1000 — Dashboard can stay underneath when
 *   user pops settings open on top of it).
 * - Esc closes; clicking the dim backdrop closes.
 */

import { useEffect, useMemo } from 'react';
import { X } from 'lucide-react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useAppStore } from '../../store';
import { useTranslation } from '@/i18n';
import { useSettingsSections, type SettingsGroup, type SettingsSection } from './store';
import './SettingsPanel.css';

const GROUP_ORDER: SettingsGroup[] = ['config', 'plugin', 'system', 'account', 'about', 'other'];

export function SettingsPanel() {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.settingsOpen);
  const setOpen = useAppStore((s) => s.setSettingsOpen);
  const activeId = useAppStore((s) => s.settingsSection);
  const setActive = useAppStore((s) => s.setSettingsSection);
  const sections = useSettingsSections();

  const sorted = useMemo(
    () => [...sections].sort((a, b) => b.priority - a.priority),
    [sections],
  );

  const grouped = useMemo(() => {
    const map = new Map<SettingsGroup, SettingsSection[]>();
    for (const s of sorted) {
      const g = s.group ?? 'other';
      const arr = map.get(g) ?? [];
      arr.push(s);
      map.set(g, arr);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ group: g, items: map.get(g)! }));
  }, [sorted]);

  // Esc + scroll-lock + focus-trap now handled by Radix Dialog.

  // Auto-select first section when none is set OR the current one disappears.
  useEffect(() => {
    if (!open) return;
    const hit = activeId && sorted.some((s) => s.id === activeId);
    if (!hit && sorted[0]) setActive(sorted[0].id);
  }, [open, sorted, activeId, setActive]);

  const active = sorted.find((s) => s.id === activeId) ?? sorted[0] ?? null;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="settings-panel-overlay" />
        <DialogPrimitive.Content
          className="settings-panel-shell settings-panel-shell--dialog"
          aria-label="Settings"
        >
          <header className="sp-header">
            <DialogPrimitive.Title className="sp-title">{t('settings.title')}</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sp-subtitle">
              {t('settings.subtitle')}
            </DialogPrimitive.Description>
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                className="sp-close"
                title={t('settings.closeEsc')}
                aria-label={t('settings.closeAria')}
              >
                <X size={16} />
              </button>
            </DialogPrimitive.Close>
          </header>

          <div className="sp-body">
          <nav className="sp-nav" aria-label="settings sections">
            {grouped.map(({ group, items }) => (
              <div key={group} className="sp-nav-group">
                <div className="sp-nav-group-label">{t(`settings.groups.${group}`)}</div>
                {items.map((s) => {
                  const Icon = s.icon;
                  const isActive = active && s.id === active.id;
                  return (
                    <button
                      type="button"
                      key={s.id}
                      className={`sp-nav-row ${isActive ? 'is-active' : ''}`}
                      onClick={() => setActive(s.id)}
                      title={s.description ?? s.label}
                    >
                      {Icon && <Icon size={14} className="sp-nav-ico" />}
                      <span className="sp-nav-label">{s.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
            {grouped.length === 0 && (
              <div className="sp-nav-empty">{t('settings.noSections')}</div>
            )}
          </nav>

          <section className="sp-content thin-scrollbar">
            {active ? (
              <>
                <div className="sp-content-head">
                  <h2 className="sp-content-title">{active.label}</h2>
                  {active.description && (
                    <p className="sp-content-desc">{active.description}</p>
                  )}
                </div>
                <div className="sp-content-body">{active.node}</div>
              </>
            ) : (
              <div className="sp-content-empty">
                <p>{t('settings.noSectionsHint1')}</p>
                <p>{t('settings.noSectionsHint2')}</p>
              </div>
            )}
          </section>
        </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
