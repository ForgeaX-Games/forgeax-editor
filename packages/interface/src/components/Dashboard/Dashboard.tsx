// Dashboard — overlay monitoring view for the studio.
//
// Reduced to 3 sub-pages after the R3 rewrite collapsed Run + Thread + Session
// into one Session model and retired the daemons subsystem:
//   - Overview:  health pills + session-level totals
//   - Sessions:  per-session table (was Threads) over /api/sessions
//   - Analytics: client-side aggregates over sessions[]
// Runs / Agents Hub tabs deleted along with their data sources.

import { useEffect, useRef, useState } from 'react';
import { X, LayoutDashboard, MessagesSquare, Layers, BarChart3 } from 'lucide-react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useTranslation } from '@/i18n';
import { useAppStore } from '../../store';
import { Overview } from './Overview';
import { SessionsList } from './ThreadsList';
import { Analytics } from './Analytics';
import './Dashboard.css';

type DashPage = 'overview' | 'sessions' | 'analytics';
type CountKey = 'sessions';

interface NavItem {
  id: DashPage;
  label: string;
  icon: React.ReactNode;
  countKey?: CountKey;
}
const NAV: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: <LayoutDashboard size={14} /> },
  { id: 'sessions', label: 'Sessions', icon: <MessagesSquare size={14} />, countKey: 'sessions' },
  { id: 'analytics', label: 'Analytics', icon: <BarChart3 size={14} /> },
];

type DashCounts = { sessions: number | null };
const EMPTY_COUNTS: DashCounts = { sessions: null };

export function Dashboard() {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.dashboardOpen);
  const setOpen = useAppStore((s) => s.setDashboardOpen);
  const [page, setPage] = useState<DashPage>('overview');
  const [counts, setCounts] = useState<DashCounts>(EMPTY_COUNTS);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const pull = () => {
      fetch('/api/sessions')
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((j: { sessions?: unknown[] }) => {
          if (cancelled) return;
          setCounts({
            sessions: Array.isArray(j?.sessions) ? j.sessions.length : null,
          });
        })
        .catch(() => { /* ignore — chip stays at last known value */ });
    };
    pull();
    const id = setInterval(pull, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [open]);

  const navRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIdx = NAV.findIndex((n) => n.id === page);
  const onNavKey = (idx: number) => (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const last = NAV.length - 1;
    let next: number | null = null;
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowLeft':
        next = idx === 0 ? last : idx - 1;
        break;
      case 'ArrowDown':
      case 'ArrowRight':
        next = idx === last ? 0 : idx + 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      default:
        return;
    }
    e.preventDefault();
    setPage(NAV[next].id);
    requestAnimationFrame(() => navRefs.current[next!]?.focus());
  };

  // Esc + scroll-lock + focus-trap now handled by Radix Dialog.

  const brandTotal = counts.sessions;
  const brandTotalTitle =
    brandTotal == null
      ? t('common.loading')
      : t('dashboard.brandTotalTitle', { count: brandTotal });
  const brandTotalAria =
    brandTotal == null ? undefined : `Total ${brandTotal} sessions`;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dash-overlay" />
        <DialogPrimitive.Content
          className="dash-shell dash-shell--dialog"
          aria-label="Dashboard"
          aria-describedby={undefined}
        >
          <header className="dash-header">
            <Layers size={16} />
            <DialogPrimitive.Title className="dash-title">Dashboard</DialogPrimitive.Title>
            {brandTotal != null && (
              <span
                className="dash-brand-total"
                title={brandTotalTitle}
                aria-label={brandTotalAria}
              >
                <span className="dash-brand-sigma" aria-hidden>Σ</span>
                <span className="dash-brand-n">{brandTotal}</span>
              </span>
            )}
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                className="dash-close"
                title={t('dashboard.closeTitle')}
                aria-label="close dashboard"
              >
                <X size={16} />
              </button>
            </DialogPrimitive.Close>
          </header>
        <div className="dash-body">
        <aside className="dash-sidebar">
          <nav
            className="dash-nav"
            role="tablist"
            aria-orientation="vertical"
            aria-label="Dashboard sub-pages"
          >
            {NAV.map((n, idx) => {
              const c = n.countKey ? counts[n.countKey] : null;
              const showChip = n.countKey != null && c != null;
              const chipTone = showChip && c! > 0 ? 'is-on' : 'is-zero';
              return (
                <button
                  key={n.id}
                  ref={(el) => { navRefs.current[idx] = el; }}
                  className={`dash-nav-item ${page === n.id ? 'active' : ''}`}
                  onClick={() => setPage(n.id)}
                  onKeyDown={onNavKey(idx)}
                  role="tab"
                  aria-selected={page === n.id}
                  tabIndex={activeIdx === idx ? 0 : -1}
                  title={
                    showChip
                      ? t('dashboard.navItemTitleWithCount', { label: n.label, count: c })
                      : t('dashboard.navItemTitle', { label: n.label })
                  }
                  aria-label={
                    showChip ? `${n.label}, ${c} items` : undefined
                  }
                >
                  {n.icon}
                  <span>{n.label}</span>
                  {showChip ? (
                    <span
                      className={`dash-nav-count ${chipTone}`}
                      aria-hidden="true"
                    >
                      {c}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>
        </aside>
        <main className="dash-content thin-scrollbar">
          {page === 'overview' && <Overview />}
          {page === 'sessions' && <SessionsList />}
          {page === 'analytics' && <Analytics />}
        </main>
        </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
