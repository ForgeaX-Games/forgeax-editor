// Dashboard Overview — at-a-glance status after the R3 rewrite:
//   - 4 stat cards: total sessions / running sessions / total agents / running agents
//   - Bus host stats + 6-kind LED strip (unchanged — Bus subsystem stays)
//   - Providers grid (cli-providers health pills)
//   - Recent Sessions table (latest 10 sessions, sid + agent counts)
//
// All run/daemon-derived rows (Recent Runs, Top Emitters) deleted along with
// their backing endpoints. Where the old surface deep-linked Bus / Providers /
// Agents into the BusAdminPanel, those still work.

import { useEffect, useState } from 'react';
import {
  dashApi,
  summarizeSessions,
  type SessionListItem,
  type SessionAgentSummary,
  type ProviderHealth,
} from '../../lib/dashboard-api';
import { listBusPlugins } from '../../lib/bus-api';
import { useAppStore } from '../../store';
import { useTranslation } from '@/i18n';

function shortCliId(busId: string): string {
  return busId.replace(/^@forgeax-plugin\/cli-/, '');
}

function shortSid(sid: string): string {
  return sid.length > 8 ? sid.slice(0, 8) : sid;
}

function StatCard({ label, value, tone, onClick, title }: {
  label: string;
  value: number | string;
  tone?: 'ok' | 'warn' | 'err' | 'idle';
  onClick?: () => void;
  title?: string;
}) {
  const cls = `dash-stat dash-stat-${tone ?? 'idle'}${onClick ? ' is-link' : ''}`;
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick} title={title}>
        <div className="dash-stat-label">{label}</div>
        <div className="dash-stat-value">{value}</div>
      </button>
    );
  }
  return (
    <div className={cls} title={title}>
      <div className="dash-stat-label">{label}</div>
      <div className="dash-stat-value">{value}</div>
    </div>
  );
}

interface BusStats {
  pluginCount: number;
  brokenCount: number;
  listenerCount: number;
  ringSize: number;
  uptimeMs: number;
}

interface UiSurfaceWire {
  id: string;
  layer: string;
  exposedToAI: boolean;
  actions: { id: string; exposedToAI: boolean }[];
}

export function Overview() {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [summaries, setSummaries] = useState<Map<string, SessionAgentSummary>>(new Map());
  const [providers, setProviders] = useState<ProviderHealth[]>([]);
  const [health, setHealth] = useState<{ pid: number; uptime: number; projectRoot: string } | null>(null);
  const [bus, setBus] = useState<BusStats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [knownProviderIds, setKnownProviderIds] = useState<ReadonlySet<string> | null>(null);
  const [surfaces, setSurfaces] = useState<{ count: number; aiActions: number; totalActions: number } | null>(null);
  const [kindCounts, setKindCounts] = useState<Map<string, number> | null>(null);

  const switchToSession = useAppStore((s) => s.switchToSession);
  const setDashboardOpen = useAppStore((s) => s.setDashboardOpen);
  const openSettings = useAppStore((s) => s.openSettings);
  const setPendingBusKindFilter = useAppStore((s) => s.setPendingBusKindFilter);
  const setPendingBusExpandId = useAppStore((s) => s.setPendingBusExpandId);
  const goBus = (): void => {
    setPendingBusKindFilter(null);
    openSettings('plugins');
  };
  const goBusProvider = (providerId: string): void => {
    setPendingBusKindFilter('cli-provider');
    setPendingBusExpandId(`@forgeax-plugin/cli-${providerId}`);
    openSettings('plugins');
  };
  const goBusKind = (kind: string): void => {
    setPendingBusExpandId(null);
    setPendingBusKindFilter(kind);
    openSettings('plugins');
  };

  const refresh = async (): Promise<void> => {
    try {
      const [s, p, h] = await Promise.all([
        dashApi.sessions(),
        dashApi.providers(),
        dashApi.health(),
      ]);
      setSessions(s.sessions);
      setProviders(p.providers);
      setHealth({ pid: h.pid, uptime: h.uptime, projectRoot: h.projectRoot });
      setBus(h.bus ?? null);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  // Slow cadence — sessions don't churn nearly as fast as runs used to.
  // 5s gives a snappy enough first paint when the dashboard pops open without
  // hammering the server while it's sitting there.
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  // Per-session agent summaries — refresh when sid set changes.
  const sidKey = sessions.map((s) => s.sid).join('|');
  useEffect(() => {
    if (sessions.length === 0) {
      setSummaries(new Map());
      return;
    }
    let cancelled = false;
    void dashApi.sessionAgentSummaries(sessions.map((s) => s.sid)).then((m) => {
      if (!cancelled) setSummaries(m);
    });
    return () => { cancelled = true; };
  }, [sidKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;
    listBusPlugins('cli-provider')
      .then((r) => { if (!cancelled) setKnownProviderIds(new Set(r.items.map((p) => shortCliId(p.id)))); })
      .catch(() => { if (!cancelled) setKnownProviderIds(new Set()); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    listBusPlugins()
      .then((r) => {
        if (cancelled) return;
        const m = new Map<string, number>();
        for (const p of r.items) m.set(p.kind, (m.get(p.kind) ?? 0) + 1);
        setKindCounts(m);
      })
      .catch(() => { if (!cancelled) setKindCounts(new Map()); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/bus/ui/surfaces')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { items?: UiSurfaceWire[] } | null) => {
        if (cancelled) return;
        const items = j?.items ?? [];
        const totalActions = items.reduce((n, s) => n + s.actions.length, 0);
        const aiActions = items.reduce(
          (n, s) => n + (s.exposedToAI ? s.actions.filter((a) => a.exposedToAI).length : 0),
          0,
        );
        setSurfaces({ count: items.length, aiActions, totalActions });
      })
      .catch(() => { if (!cancelled) setSurfaces({ count: 0, aiActions: 0, totalActions: 0 }); });
    return () => { cancelled = true; };
  }, []);

  const { totals } = summarizeSessions(sessions, summaries);
  const healthyProviders = providers.filter((p) => p.health.ok).length;

  const onOpenSession = (sid: string): void => {
    void switchToSession(sid);
    setDashboardOpen(false);
  };

  return (
    <div className="dash-page">
      <h2 className="dash-h">Overview</h2>
      {err && <div className="dash-err">{err}</div>}

      <div className="dash-stat-row">
        <StatCard label="Total Sessions" value={totals.sessionCount} tone="idle" />
        <StatCard
          label="Running Sessions"
          value={totals.runningSessions}
          tone={totals.runningSessions > 0 ? 'ok' : 'idle'}
        />
        <StatCard label="Total Agents" value={totals.agentCount} tone="idle" />
        <StatCard
          label="Running Agents"
          value={totals.runningAgents}
          tone={totals.runningAgents > 0 ? 'ok' : 'idle'}
        />
      </div>

      {bus && (
        <>
          <h3 className="dash-h3">
            Bus <span className="dash-h3-sub">— plugin host @ /api/bus · click → bus admin</span>
          </h3>
          <div className="dash-kind-strip" role="group" aria-label="Bus plugin distribution by kind">
            <span className="dash-kind-strip-label">BUS KINDS</span>
            {(['workbench', 'agent', 'cli-provider', 'model-binding', 'skill', 'tool'] as const).map((kind) => {
              const KIND_LABEL: Record<string, string> = {
                workbench: 'WB',
                agent: 'AGENT',
                'cli-provider': 'PROV',
                'model-binding': 'MB',
                skill: 'SKILL',
                tool: 'TOOL',
              };
              const KIND_LONG: Record<string, string> = {
                workbench: 'workbench',
                agent: 'agent',
                'cli-provider': 'cli-provider',
                'model-binding': 'model-binding',
                skill: 'skill',
                tool: 'tool',
              };
              const loading = kindCounts === null;
              const count = kindCounts?.get(kind) ?? 0;
              const tone: 'loading' | 'ok' | 'down' = loading ? 'loading' : count > 0 ? 'ok' : 'down';
              const title = loading
                ? t('dashboard.busKindRegistering', { kind: KIND_LONG[kind] })
                : count > 0
                  ? `${count} ${KIND_LONG[kind]} plugin${count === 1 ? '' : 's'} · ${t('dashboard.clickToBusAdmin')}`
                  : `0 ${KIND_LONG[kind]} plugin · ${t('dashboard.clickToBusAdmin')}`;
              return (
                <button
                  type="button"
                  key={kind}
                  className={`dash-kind-led dash-kind-k-${kind} is-${tone}`}
                  onClick={() => goBusKind(kind)}
                  title={title}
                  aria-label={`${KIND_LONG[kind]} · ${loading ? 'loading' : count} plugins`}
                >
                  <span className="dash-kind-dot" aria-hidden />
                  <span className="dash-kind-label">{KIND_LABEL[kind]}</span>
                  <span className="dash-kind-count">{loading ? '·' : count}</span>
                </button>
              );
            })}
          </div>
          <div className="dash-stat-row dash-stat-row-bus">
            <StatCard
              label="Plugins"
              value={bus.pluginCount}
              tone="ok"
              onClick={goBus}
              title={`${bus.pluginCount} plugins loaded · ${t('dashboard.clickToBusDetail')}`}
            />
            <StatCard
              label="Broken"
              value={bus.brokenCount}
              tone={bus.brokenCount > 0 ? 'err' : 'idle'}
              onClick={goBus}
              title={
                bus.brokenCount > 0
                  ? `${bus.brokenCount} broken plugin${bus.brokenCount === 1 ? '' : 's'} · ${t('dashboard.clickToBusDetail')}`
                  : `0 broken · ${t('dashboard.clickToBusDetail')}`
              }
            />
            <StatCard
              label="Listeners"
              value={bus.listenerCount}
              tone={bus.listenerCount > 0 ? 'ok' : 'idle'}
              onClick={goBus}
              title={`${bus.listenerCount} event listener${bus.listenerCount === 1 ? '' : 's'} · ${t('dashboard.clickToBusDetail')}`}
            />
            <StatCard
              label="Ring size"
              value={bus.ringSize}
              tone="idle"
              onClick={goBus}
              title={`ring buffer size ${bus.ringSize} · ${t('dashboard.clickToBusDetail')}`}
            />
            <StatCard
              label="Uptime"
              value={formatDuration(bus.uptimeMs)}
              tone="idle"
              onClick={goBus}
              title={`bus uptime ${formatDuration(bus.uptimeMs)} · ${t('dashboard.clickToBusDetail')}`}
            />
            {surfaces && (
              <StatCard
                label="Surfaces"
                value={`${surfaces.count} · ${surfaces.aiActions}/${surfaces.totalActions}`}
                tone={surfaces.count > 0 ? 'ok' : 'idle'}
                onClick={goBus}
                title={
                  surfaces.count > 0
                    ? `${surfaces.count} UI surface${surfaces.count === 1 ? '' : 's'} · ${surfaces.aiActions}/${surfaces.totalActions} AI-exposed actions · ${t('dashboard.clickToBusDetail')}`
                    : `0 UI surfaces · ${t('dashboard.clickToBusDetail')}`
                }
              />
            )}
          </div>
        </>
      )}

      <h3 className="dash-h3">
        Providers <span className="dash-h3-sub">— {healthyProviders}/{providers.length} healthy</span>
      </h3>
      <div className="dash-provider-grid">
        {providers.map((p) => {
          const hasBus = knownProviderIds ? knownProviderIds.has(p.id) : null;
          return (
            <div key={p.id} className={`dash-provider ${p.health.ok ? 'ok' : 'down'}`}>
              <div className="dash-provider-name">{p.displayName}</div>
              <div className="dash-provider-id">{p.id}</div>
              <div className="dash-provider-status">{p.health.ok ? '✓ healthy' : 'DOWN'}</div>
              {p.health.detail && <div className="dash-provider-detail" title={p.health.detail}>{p.health.detail.slice(0, 80)}</div>}
              <div className="dash-provider-bus-row">
                <button
                  type="button"
                  className={`dash-provider-bus-pill ${
                    hasBus === null ? 'is-pending' : hasBus ? 'is-on' : 'is-off'
                  }`}
                  disabled={!hasBus}
                  onClick={() => hasBus && goBusProvider(p.id)}
                  title={
                    hasBus === null
                      ? `${p.id} · bus plugin registry loading…`
                      : hasBus
                        ? `${p.id} · wrapped by @forgeax-plugin/cli-${p.id} · ${t('dashboard.clickToBusAdmin')}`
                        : `${p.id} · no matching cli-provider plugin on bus`
                  }
                >
                  <span className="dash-provider-bus-dot" aria-hidden />
                  bus {hasBus === null ? '—' : hasBus ? '✓' : '✗'}
                </button>
              </div>
            </div>
          );
        })}
        {providers.length === 0 && (
          <div className="dash-empty">No cli-providers registered.</div>
        )}
      </div>

      <h3 className="dash-h3">Recent Sessions</h3>
      <table className="dash-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>SID</th>
            <th>Default dir</th>
            <th>Agents</th>
            <th>Running</th>
          </tr>
        </thead>
        <tbody>
          {sessions.slice(0, 10).map((s) => {
            const sum = summaries.get(s.sid);
            return (
              <tr key={s.sid}>
                <td className="dash-msg-cell">
                  <button
                    type="button"
                    className="dash-prov-cell-link"
                    onClick={() => onOpenSession(s.sid)}
                    title={`Open session ${shortSid(s.sid)} in chat`}
                  >
                    <span className="dash-prov-cell-id">{s.displayName || `session ${shortSid(s.sid)}`}</span>
                    <span className="dash-prov-cell-arrow" aria-hidden>→</span>
                  </button>
                </td>
                <td title={s.sid}><code>{shortSid(s.sid)}</code></td>
                <td title={s.defaultDir ?? ''}>{s.defaultDir ?? '—'}</td>
                <td>{sum ? sum.agentCount : '…'}</td>
                <td>
                  {sum ? (
                    <span className={sum.runningCount > 0 ? 'dash-running' : ''}>{sum.runningCount}</span>
                  ) : '…'}
                </td>
              </tr>
            );
          })}
          {sessions.length === 0 && (
            <tr><td colSpan={5} className="dash-empty">No sessions yet — start a chat in the studio.</td></tr>
          )}
        </tbody>
      </table>

      {health && (
        <div className="dash-foot">
          server pid {health.pid} · uptime {Math.floor(health.uptime / 60)}m{Math.floor(health.uptime % 60)}s · projectRoot {health.projectRoot}
        </div>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return `${h}h${rm}m`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
}
