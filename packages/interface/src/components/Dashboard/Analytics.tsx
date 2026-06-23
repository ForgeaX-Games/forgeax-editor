// Analytics — usage totals derived client-side from /api/sessions + list_agents.
//
// After the R3 rewrite the Run-centric aggregates (per-day Run trend, by
// provider Run counts, AG-UI events) are gone — there's no Run model anymore.
// What remains useful at the dashboard level:
//   - Session totals (count, running, agents-per-session)
//   - Bus host snapshot + Plugins by kind (unchanged — Bus subsystem stays)
//   - Sessions by default-dir distribution
//   - Active sessions table (sessions with at least one running agent)

import { useEffect, useState } from 'react';
import {
  dashApi,
  summarizeSessions,
  type SessionListItem,
  type SessionAgentSummary,
} from '../../lib/dashboard-api';
import { listBusPlugins, type BusPluginInfo } from '../../lib/bus-api';
import { useAppStore } from '../../store';

interface BusHealth {
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

const KIND_ORDER: { id: string; label: string }[] = [
  { id: 'workbench',     label: 'workbench' },
  { id: 'cli-provider',  label: 'cli-provider' },
  { id: 'agent',         label: 'agent' },
  { id: 'model-binding', label: 'model-binding' },
  { id: 'skill',         label: 'skill' },
  { id: 'tool',          label: 'tool' },
];

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function shortSid(sid: string): string {
  return sid.length > 8 ? sid.slice(0, 8) : sid;
}

export function Analytics() {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [summaries, setSummaries] = useState<Map<string, SessionAgentSummary>>(new Map());
  const [busHealth, setBusHealth] = useState<BusHealth | null>(null);
  const [busPlugins, setBusPlugins] = useState<BusPluginInfo[] | null>(null);
  const [surfaces, setSurfaces] = useState<{ count: number; aiActions: number; totalActions: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const openSettings = useAppStore((s) => s.openSettings);
  const setPendingBusKindFilter = useAppStore((s) => s.setPendingBusKindFilter);
  const setPendingBusExpandId = useAppStore((s) => s.setPendingBusExpandId);
  const switchToSession = useAppStore((s) => s.switchToSession);
  const setDashboardOpen = useAppStore((s) => s.setDashboardOpen);

  const goBus = (): void => {
    setPendingBusKindFilter(null);
    openSettings('plugins');
  };
  const goBusKind = (kind: string): void => {
    setPendingBusExpandId(null);
    setPendingBusKindFilter(kind);
    openSettings('plugins');
  };
  const onOpenSession = (sid: string): void => {
    void switchToSession(sid);
    setDashboardOpen(false);
  };

  useEffect(() => {
    const tick = async (): Promise<void> => {
      try {
        const [s, h, p] = await Promise.all([
          dashApi.sessions(),
          dashApi.health().catch(() => null),
          listBusPlugins().catch(() => null),
        ]);
        setSessions(s.sessions);
        if (h?.bus) setBusHealth(h.bus);
        if (p) setBusPlugins(p.items);
        setErr(null);
      } catch (e) { setErr((e as Error).message); }
    };
    void tick();
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, []);

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

  const byKind: Record<string, number> = {};
  if (busPlugins) for (const p of busPlugins) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
  const kindTotal = busPlugins?.length ?? 0;
  const maxKind = Math.max(1, ...KIND_ORDER.map((k) => byKind[k.id] ?? 0));

  const { totals, byDir } = summarizeSessions(sessions, summaries);

  const activeSessions = sessions.filter((s) => {
    const sum = summaries.get(s.sid);
    return sum && sum.runningCount > 0;
  });

  return (
    <div className="dash-page">
      <h2 className="dash-h">Analytics</h2>
      {err && <div className="dash-err">{err}</div>}

      <div className="dash-stat-row">
        <div className="dash-stat dash-stat-idle" title={`${totals.sessionCount} session${totals.sessionCount === 1 ? '' : 's'}`}>
          <div className="dash-stat-label">Total Sessions</div>
          <div className="dash-stat-value">{totals.sessionCount}</div>
        </div>
        <div className={`dash-stat ${totals.runningSessions > 0 ? 'dash-stat-ok' : 'dash-stat-idle'}`} title={`${totals.runningSessions} with at least one running agent`}>
          <div className="dash-stat-label">Running Sessions</div>
          <div className="dash-stat-value">{totals.runningSessions}</div>
        </div>
        <div className="dash-stat dash-stat-idle" title={`${totals.agentCount} agents across all sessions`}>
          <div className="dash-stat-label">Total Agents</div>
          <div className="dash-stat-value">{totals.agentCount}</div>
        </div>
        <div className={`dash-stat ${totals.runningAgents > 0 ? 'dash-stat-ok' : 'dash-stat-idle'}`} title={`${totals.runningAgents} agents currently running`}>
          <div className="dash-stat-label">Running Agents</div>
          <div className="dash-stat-value">{totals.runningAgents}</div>
        </div>
      </div>

      {busHealth && (
        <>
          <h3 className="dash-h3">
            Bus host <span className="dash-h3-sub">— plugin host snapshot @ /api/bus</span>
          </h3>
          <div className="dash-stat-row dash-stat-row-bus">
            <button
              type="button"
              className="dash-stat is-link dash-stat-ok"
              onClick={goBus}
              title={`${busHealth.pluginCount} plugin${busHealth.pluginCount === 1 ? '' : 's'} loaded · 单击切到 Bus 详情 →`}
            >
              <div className="dash-stat-label">Plugins</div>
              <div className="dash-stat-value">{busHealth.pluginCount}</div>
            </button>
            <button
              type="button"
              className={`dash-stat is-link ${busHealth.brokenCount === 0 ? 'dash-stat-ok' : 'dash-stat-idle'}`}
              onClick={goBus}
              title={`${busHealth.pluginCount - busHealth.brokenCount} healthy · 单击切到 Bus 详情 →`}
            >
              <div className="dash-stat-label">Healthy</div>
              <div className="dash-stat-value">{busHealth.pluginCount - busHealth.brokenCount}</div>
            </button>
            <button
              type="button"
              className={`dash-stat is-link ${busHealth.brokenCount > 0 ? 'dash-stat-err' : 'dash-stat-idle'}`}
              onClick={goBus}
              title={busHealth.brokenCount > 0 ? `${busHealth.brokenCount} broken · 单击切到 Bus 详情 →` : '0 broken · 单击切到 Bus 详情 →'}
            >
              <div className="dash-stat-label">Broken</div>
              <div className="dash-stat-value">{busHealth.brokenCount}</div>
            </button>
            <button
              type="button"
              className="dash-stat is-link dash-stat-idle"
              onClick={goBus}
              title={`${busHealth.listenerCount} listener${busHealth.listenerCount === 1 ? '' : 's'} · 单击切到 Bus 详情 →`}
            >
              <div className="dash-stat-label">Listeners</div>
              <div className="dash-stat-value">{busHealth.listenerCount}</div>
            </button>
            <button
              type="button"
              className="dash-stat is-link dash-stat-idle"
              onClick={goBus}
              title={`Bus uptime ${formatDuration(busHealth.uptimeMs)} · 单击切到 Bus 详情 →`}
            >
              <div className="dash-stat-label">Uptime</div>
              <div className="dash-stat-value">{formatDuration(busHealth.uptimeMs)}</div>
            </button>
            {surfaces && (
              <button
                type="button"
                className={`dash-stat is-link ${surfaces.count > 0 ? 'dash-stat-ok' : 'dash-stat-idle'}`}
                onClick={goBus}
                title={
                  surfaces.count > 0
                    ? `${surfaces.count} UI surface${surfaces.count === 1 ? '' : 's'} · ${surfaces.aiActions}/${surfaces.totalActions} AI · 单击切到 Bus 详情 →`
                    : '0 UI surfaces · 单击切到 Bus 详情 →'
                }
              >
                <div className="dash-stat-label">Surfaces</div>
                <div className="dash-stat-value">{surfaces.count} · {surfaces.aiActions}/{surfaces.totalActions}</div>
              </button>
            )}
          </div>

          {busPlugins && (
            <>
              <h3 className="dash-h3">
                Plugins by kind
                <span className="dash-h3-sub">
                  — {kindTotal} plugins · {KIND_ORDER.filter((k) => (byKind[k.id] ?? 0) > 0).length} kinds active · click → bus admin
                </span>
              </h3>
              <div className="dash-kind-bars">
                {KIND_ORDER.map((k) => {
                  const n = byKind[k.id] ?? 0;
                  const pct = (n / maxKind) * 100;
                  if (n === 0) {
                    return (
                      <div key={k.id} className={`dash-kind-row k-${k.id} is-empty`}>
                        <div className="dash-kind-name">{k.label}</div>
                        <div className="dash-kind-track">
                          <div className="dash-kind-fill" style={{ width: `${pct}%` }} />
                        </div>
                        <div className="dash-kind-num">{n}</div>
                      </div>
                    );
                  }
                  return (
                    <button
                      type="button"
                      key={k.id}
                      className={`dash-kind-row k-${k.id} is-link`}
                      title={`${k.label} · ${n} plugin${n === 1 ? '' : 's'} · 单击 → Bus admin (filter=${k.label}) →`}
                      onClick={() => goBusKind(k.id)}
                    >
                      <span className="dash-kind-name">{k.label}</span>
                      <span className="dash-kind-track">
                        <span className="dash-kind-fill" style={{ width: `${pct}%` }} />
                      </span>
                      <span className="dash-kind-num">{n}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}

      <h3 className="dash-h3">Sessions by default dir</h3>
      <table className="dash-table">
        <thead>
          <tr>
            <th>Default dir</th>
            <th>Sessions</th>
            <th>Running</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(byDir).sort((a, b) => b[1].sessionCount - a[1].sessionCount).map(([dir, v]) => (
            <tr key={dir}>
              <td title={dir}>{dir}</td>
              <td>{v.sessionCount}</td>
              <td>{v.runningCount > 0 ? <span className="dash-running">{v.runningCount}</span> : '—'}</td>
            </tr>
          ))}
          {Object.keys(byDir).length === 0 && (
            <tr><td colSpan={3} className="dash-empty">No sessions to analyze.</td></tr>
          )}
        </tbody>
      </table>

      {activeSessions.length > 0 && (
        <>
          <h3 className="dash-h3">Active sessions ({activeSessions.length})</h3>
          <table className="dash-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>SID</th>
                <th>Default dir</th>
                <th>Running agents</th>
                <th>Total agents</th>
              </tr>
            </thead>
            <tbody>
              {activeSessions.map((s) => {
                const sum = summaries.get(s.sid)!;
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
                    <td><code>{shortSid(s.sid)}</code></td>
                    <td title={s.defaultDir ?? ''}>{s.defaultDir ?? '—'}</td>
                    <td><span className="dash-running">{sum.runningCount}</span></td>
                    <td>{sum.agentCount}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
