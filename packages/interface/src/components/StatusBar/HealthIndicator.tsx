/**
 * HealthIndicator — the compact "latest health state" chip on the FAR RIGHT of
 * the GlobalStatusBar.
 *
 * Replaces the old full-width HealthStatusBar strip: that strip's "latest line"
 * job collapses to this one chip (severity icon + truncated latest message +
 * ✖N⚠N counts), and its "full list" job moves to the Info dock panel. Clicking
 * the chip opens / focuses that Info panel via the 'app.panel.open' command.
 *
 * Data comes from the standalone healthStore (same source the Info panel reads),
 * registered onto the bar via useStatusBarItem — no new data flow.
 */

import { useMemo } from 'react';
import { Info, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useHealthStore, type HealthLevel } from './healthStore';
import { useStatusBarItem } from './store';
import { useCommand } from '../../core/app-shell';
import './HealthIndicator.css';

const ICONS: Record<HealthLevel, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warn: AlertTriangle,
  error: XCircle,
};

export function HealthIndicator() {
  const { t } = useTranslation();
  const entries = useHealthStore((s) => s.entries);
  const latest = entries.length ? entries[entries.length - 1]! : null;

  // Open (or focus) the standalone Info dock panel via the command bus. Same
  // semantics as the previous APP_EVENTS.openPanel CustomEvent — 'app.panel.open'
  // emits 'panel:open' on the host bus, DockRegion subscribes and reopens/focuses.
  const openInfoPanel = useCommand<{ id: string }>('app.panel.open');

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

  const node = (
    <button
      type="button"
      className={`sb-health sb-health--${level}`}
      onClick={() => { void openInfoPanel({ id: 'info' }); }}
      title={title}
      aria-label="Latest health status — open Info panel"
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

  useStatusBarItem({
    id: 'health.latest',
    // The 'center' slot is the bar's flex spacer (it grows to fill the gap
    // between the left/right chip groups and the bar's right edge). We align
    // its content flex-end (see GlobalStatusBar.css) so this single chip pins
    // to the FAR RIGHT of the status bar.
    slot: 'center',
    priority: 10,
    node,
  });

  return null;
}
