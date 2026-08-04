/**
 * DrawerLauncher — the bottom drawer's launcher tabs, rendered INSIDE the
 * status bar (a `custom` strip contribution, ADR-0030 §2.3). Keeping the
 * launcher in the strip means the footer stays a single row; clicking a tab
 * toggles its panel, which DrawerHostView expands upward.
 *
 * Self-contained + reactive: subscribes to useDrawerStore so the active tab
 * highlight updates independently of the strip snapshot (the strip item itself
 * is registered once and never re-derives on drawer open/close).
 */
import { type ReactElement } from 'react';
import { icons as LucideIcons } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { usePanelRenderers } from '../DockShell/panelRenderers';
import { useDrawerStore } from './useDrawerStore';

export function DrawerLauncher(): ReactElement | null {
  const { t } = useTranslation();
  const drawerPanels = usePanelRenderers().drawerPanels;
  const activeId = useDrawerStore((s) => s.activeId);
  const toggle = useDrawerStore((s) => s.toggle);

  const panels = Object.values(drawerPanels ?? {})
    .filter((p) => !p.when || p.when())
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  if (panels.length === 0) return null;

  return (
    <span className="fx-drawer-launcher" role="tablist" aria-label="Bottom drawer">
      {panels.map((p) => {
        const Icon = p.icon ? LucideIcons[p.icon as keyof typeof LucideIcons] : undefined;
        const isActive = activeId === p.id;
        const label = p.titleKey ? t(p.titleKey) : p.title;
        return (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`sb-chip fx-drawer-tab${isActive ? ' is-active' : ''}`}
            onClick={() => toggle(p.id)}
            title={label}
          >
            {Icon ? <Icon size={14} strokeWidth={1.75} className="fx-drawer-tab-ic" /> : null}
            <span className="fx-drawer-tab-lb">{label}</span>
          </button>
        );
      })}
    </span>
  );
}
