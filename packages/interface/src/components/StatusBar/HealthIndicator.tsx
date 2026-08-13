/**
 * HealthChip — the compact "latest health state" chip that starts the
 * right-aligned status cluster (statusbar.center).
 *
 * Replaces the old full-width HealthStatusBar strip: that strip's "latest line"
 * job collapses to this one chip (severity icon + truncated latest message +
 * ✖N⚠N counts), and its "full list" job moves to the Info bottom drawer.
 * Clicking the chip toggles that Info drawer via the 'app.drawer.toggle' command.
 *
 * ADR-0030 §2.2 — this chip is contributed as a `custom` StatusItemContribution
 * (`healthStatusItem`) through the single panels channel; it owns its own
 * healthStore subscription (the `custom` in-process escape hatch).
 */

import { useMemo } from 'react';
import { Info, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useHealthStore, type HealthLevel } from './healthStore';
import { useCommand } from '../../core/app-shell';
import type { StatusItemContribution } from '../../core/panels';
import './HealthIndicator.css';

const ICONS: Record<HealthLevel, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warn: AlertTriangle,
  error: XCircle,
};

export function HealthChip() {
  const { t } = useTranslation();
  const entries = useHealthStore((s) => s.entries);
  const latest = entries.length ? entries[entries.length - 1]! : null;

  // Toggle the Info bottom drawer via the command bus (ADR-0030 §2.3): the Info
  // feed now lives in the drawer, not a dock panel. 'app.drawer.toggle' expands
  // it upward (or collapses if already open).
  const toggleInfoDrawer = useCommand<{ id: string }>('app.drawer.toggle');

  const counts = useMemo(() => {
    let err = 0, warn = 0;
    for (const e of entries) {
      if (e.level === 'error') err++;
      else if (e.level === 'warn') warn++;
    }
    return { err, warn };
  }, [entries]);

  const Icon = latest ? ICONS[latest.level] : Info;
  const level = latest?.level ?? 'info';
  const msg = latest ? latest.message : 'Ready';
  const title = latest
    ? t('healthIndicator.tooltipWithMsg', { source: latest.source, message: latest.message })
    : t('healthIndicator.tooltipEmpty');

  return (
    <button
      type="button"
      className={`sb-health sb-health--${level}`}
      onClick={() => { void toggleInfoDrawer({ id: 'info' }); }}
      title={title}
      aria-label="Latest health status — toggle Info drawer"
    >
      <Icon className="sb-health-icon" size={12} />
      <span className="sb-health-msg">{msg}</span>
      {(counts.err > 0 || counts.warn > 0) && (
        <span className="sb-health-counts">
          {counts.err > 0 && <span className="sb-health-count sb-health-count--error">✖{counts.err}</span>}
          {counts.warn > 0 && <span className="sb-health-count sb-health-count--warn">⚠{counts.warn}</span>}
        </span>
      )}
    </button>
  );
}

/** ADR-0030 §2.2 — health chip as a `custom` status-item contribution. The
 *  'statusbar.center' slot starts the right-aligned footer status cluster. */
export const healthStatusItem: StatusItemContribution = {
  kind: 'status-item',
  id: 'health.latest',
  location: 'statusbar.center',
  priority: 10,
  item: { type: 'custom', render: () => <HealthChip /> },
};
