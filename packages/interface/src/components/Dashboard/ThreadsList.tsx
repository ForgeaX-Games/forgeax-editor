// Dashboard Sessions page — table over /api/sessions + per-row list_agents.
//
// Replaces the old ThreadsList after the R3 rewrite merged Thread / Run /
// Session into a single Session model. Each row links back to the chat tab
// (clicking the title switches activeSid + closes the dashboard).
//
// Polling:
//   /api/sessions       every 4s   (cheap REST)
//   list_agents         on session change   (per-sid command query, parallel)

import { useEffect, useMemo, useState } from 'react';
import { Trash2, ExternalLink } from 'lucide-react';
import { confirmDialog, alertDialog } from '@/lib/dialog';
import {
  dashApi,
  type SessionListItem,
  type SessionAgentSummary,
} from '../../lib/dashboard-api';
import { useAppStore } from '../../store';

function shortSid(sid: string): string {
  return sid.length > 8 ? sid.slice(0, 8) : sid;
}

export function SessionsList() {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [summaries, setSummaries] = useState<Map<string, SessionAgentSummary>>(new Map());
  const [query, setQuery] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const switchToSession = useAppStore((s) => s.switchToSession);
  const setDashboardOpen = useAppStore((s) => s.setDashboardOpen);
  const activeSid = useAppStore((s) => s.activeSid);

  const refreshSessions = async (): Promise<void> => {
    try {
      const r = await dashApi.sessions();
      setSessions(r.sessions);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  useEffect(() => {
    void refreshSessions();
    const t = setInterval(refreshSessions, 4000);
    return () => clearInterval(t);
  }, []);

  // Per-session agent summaries — recomputed whenever the set of sids changes.
  // 4s session poll only triggers re-fetch when sids[] actually shifts (string
  // join key); list_agents itself is hit at most every few seconds via this
  // effect, not on every render.
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

  const onDelete = async (sid: string): Promise<void> => {
    if (!(await confirmDialog({ body: `Delete session ${shortSid(sid)} and its entire ledger?`, danger: true }))) return;
    const r = await dashApi.deleteSession(sid);
    if (!r.ok) void alertDialog({ body: r.error ?? 'delete failed' });
    void refreshSessions();
  };

  const onOpen = (sid: string): void => {
    void switchToSession(sid);
    setDashboardOpen(false);
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => {
      const hay = [s.sid, s.displayName ?? '', s.defaultDir ?? ''].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [sessions, query]);

  const runningSessionCount = Array.from(summaries.values()).filter((s) => s.runningCount > 0).length;
  const totalAgents = Array.from(summaries.values()).reduce((a, s) => a + s.agentCount, 0);
  const totalRunning = Array.from(summaries.values()).reduce((a, s) => a + s.runningCount, 0);

  return (
    <div className="dash-page">
      <h2 className="dash-h">Sessions</h2>
      {err && <div className="dash-err">{err}</div>}

      <div className="dash-toolbar">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sid / name / dir"
          className="dash-search"
        />
        <span className="dash-count">
          {query.trim().length > 0
            ? `${visible.length} of ${sessions.length}`
            : `${sessions.length} session${sessions.length === 1 ? '' : 's'}`}
        </span>
        <span className="dash-count" title="sessions with at least one running agent">
          {runningSessionCount} running
        </span>
        <span className="dash-count" title="total agents across all sessions">
          {totalRunning}/{totalAgents} agents
        </span>
      </div>

      <table className="dash-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>SID</th>
            <th>Default dir</th>
            <th>Agents</th>
            <th>Running</th>
            <th>Auto-start</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {visible.map((s) => {
            const sum = summaries.get(s.sid);
            const isActive = s.sid === activeSid;
            return (
              <tr key={s.sid} className={isActive ? 'active' : ''}>
                <td className="dash-msg-cell">
                  <button
                    type="button"
                    className="dash-prov-cell-link"
                    onClick={() => onOpen(s.sid)}
                    title={`Open session ${shortSid(s.sid)} in chat`}
                  >
                    <span className="dash-prov-cell-id">
                      {s.displayName || `session ${shortSid(s.sid)}`}
                    </span>
                    <span className="dash-prov-cell-arrow" aria-hidden>→</span>
                  </button>
                </td>
                <td title={s.sid}><code>{shortSid(s.sid)}</code></td>
                <td title={s.defaultDir ?? ''}>{s.defaultDir ?? '—'}</td>
                <td>{sum ? sum.agentCount : '…'}</td>
                <td>
                  {sum ? (
                    <span className={sum.runningCount > 0 ? 'dash-running' : ''}>
                      {sum.runningCount}
                    </span>
                  ) : '…'}
                </td>
                <td>{s.autoStart ? 'yes' : '—'}</td>
                <td className="dash-row-actions">
                  <button
                    className="dash-icon-btn"
                    title="Open in chat"
                    onClick={() => onOpen(s.sid)}
                  >
                    <ExternalLink size={11} />
                  </button>
                  <button
                    className="dash-icon-btn danger"
                    title="Delete session"
                    onClick={() => void onDelete(s.sid)}
                  >
                    <Trash2 size={11} />
                  </button>
                </td>
              </tr>
            );
          })}
          {visible.length === 0 && (
            <tr><td colSpan={7} className="dash-empty">
              {sessions.length === 0 ? 'No sessions yet.' : 'No sessions match filter.'}
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
