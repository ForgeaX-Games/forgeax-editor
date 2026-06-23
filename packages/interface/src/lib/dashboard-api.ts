// Dashboard API client — thin typed wrappers over the forgeax-server endpoints.
//
// R3 migration (2026-05-20):
//   The old surface targeted `/api/runs`, `/api/threads/*`, `/api/daemons/*`
//   which were deleted in wu-tian807's runtime rewrite. Run + Thread + Session
//   collapsed into a single Session model (see docs/features/runtime-rewrite-
//   core-plan.md). Daemons concept retired entirely.
//
//   This module now exposes session-centric helpers backed by:
//     - REST  /api/sessions           (list / create / delete / abort)
//     - REST  /api/health             (uptime / wsClients / bus stats)
//     - cmd   list_agents             (per-session agent tree + running flag)
//     - cmd   fetch_session_events    (ledger replay for a single agent)
//
//   Provider health stays on the dedicated `/api/cli/health` bridge (see
//   `./cli-providers`) since cli-providers is still its own subsystem.

export interface SessionListItem {
  sid: string;
  displayName?: string;
  defaultDir?: string;
  autoStart?: boolean;
}

export interface AgentNode {
  path: string;
  display: string;
  depth: number;
  fullId: string;
  parent: string | null;
  hasLedger: boolean;
  running: boolean;
}

export interface SessionAgentSummary {
  sid: string;
  agents: AgentNode[];
  agentCount: number;
  runningCount: number;
  error?: string;
}

export interface ProviderHealth {
  id: string;
  displayName: string;
  capabilities: Record<string, boolean>;
  health: { ok: boolean; detail?: string };
}

export interface SessionLedgerEvent {
  seq: number;
  ts: number;
  source: string;
  type: string;
  payload: Record<string, unknown>;
  to?: string;
}

async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return (await r.json()) as T;
}

interface CommandResult<T> {
  result?: { ok: boolean; data?: T; error?: string };
}

async function runCommand<T>(name: string, args: unknown[]): Promise<T> {
  const r = await fetch(`/api/commands/${encodeURIComponent(name)}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args }),
  });
  if (!r.ok) throw new Error(`commands/${name} ${r.status}`);
  const j = (await r.json()) as CommandResult<T>;
  if (!j.result?.ok) throw new Error(j.result?.error ?? `commands/${name} failed`);
  return j.result.data as T;
}

export const dashApi = {
  health: () =>
    getJSON<{
      status: string;
      version: string;
      pid: number;
      uptime: number;
      projectRoot: string;
      providers: string[];
      wsClients: number;
      bus?: {
        pluginCount: number;
        brokenCount: number;
        listenerCount: number;
        ringSize: number;
        uptimeMs: number;
      };
    }>('/api/health'),

  // R3 适配:原 `/api/cli-providers` 已下线,桥到独立 `/api/cli/health`。
  // 字段 mapping 抽在 lib/cli-providers.ts,集中维护。等 commands.attach_script_agent
  // 替代当前 cli-provider 桥之后,本调用直接退役。
  providers: async (force = false): Promise<{ providers: ProviderHealth[]; cachedAt: number }> => {
    const { fetchCliProviders } = await import('./cli-providers');
    return fetchCliProviders(force);
  },

  sessions: () => getJSON<{ sessions: SessionListItem[] }>('/api/sessions'),

  /** 单 session 的 agent tree（含 running 标志）。错误时 throw,调用方决定降级。 */
  sessionAgents: (sid: string) =>
    runCommand<{ agents?: AgentNode[] }>('list_agents', [sid]).then((d) => d.agents ?? []),

  /** 批量拉多 session 的 agent 概况,失败的 session 落 `error` 字段而不是 throw。
   *  Dashboard sessions 列表用,一次性并行展开所有 sid。 */
  sessionAgentSummaries: async (sids: string[]): Promise<Map<string, SessionAgentSummary>> => {
    const m = new Map<string, SessionAgentSummary>();
    await Promise.all(
      sids.map(async (sid) => {
        try {
          const agents = await dashApi.sessionAgents(sid);
          m.set(sid, {
            sid,
            agents,
            agentCount: agents.length,
            runningCount: agents.filter((a) => a.running).length,
          });
        } catch (err) {
          m.set(sid, {
            sid,
            agents: [],
            agentCount: 0,
            runningCount: 0,
            error: (err as Error).message,
          });
        }
      }),
    );
    return m;
  },

  /** REST DELETE /api/sessions/:sid —— session 目录 + ledger 一并清理。 */
  deleteSession: async (sid: string): Promise<{ ok: boolean; error?: string }> => {
    const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' });
    if (r.ok) return { ok: true };
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: j.error ?? `HTTP ${r.status}` };
  },

  /** POST /api/sessions/:sid/abort[?agent=path] —— 打断某 agent 的当前 turn。
   *  agent 缺省时打断 session 内所有 in-flight agent。 */
  abortSession: async (sid: string, agent?: string): Promise<{ ok: boolean; error?: string }> => {
    const qs = agent ? `?agent=${encodeURIComponent(agent)}` : '';
    const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/abort${qs}`, { method: 'POST' });
    if (r.ok) return { ok: true };
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: j.error ?? `HTTP ${r.status}` };
  },

  /** ledger replay —— fetch_session_events command。`agentPath` 是 list_agents
   *  返回的 path 字段（"" = root agent）。`from` 是上一次拿到的最后一个 seq;
   *  缺省从头拉。 */
  sessionEvents: (
    sid: string,
    agentPath: string,
    opts?: { from?: number; limit?: number },
  ): Promise<SessionLedgerEvent[]> =>
    runCommand<{ events?: SessionLedgerEvent[] }>('fetch_session_events', [
      { sid, agentPath, ...(opts?.from !== undefined ? { from: opts.from } : {}), ...(opts?.limit !== undefined ? { limit: opts.limit } : {}) },
    ]).then((d) => d.events ?? []),
};

// Aggregate helpers — 客户端聚合 sessions[] 以喂 dashboard cards。
// /api/sessions 在 studio 的典型规模（≤200 条）下 O(N) 完全够用。

export function summarizeSessions(
  sessions: SessionListItem[],
  summaries: Map<string, SessionAgentSummary>,
): {
  totals: {
    sessionCount: number;
    agentCount: number;
    runningSessions: number;
    runningAgents: number;
  };
  byDir: Record<string, { sessionCount: number; runningCount: number }>;
} {
  const totals = {
    sessionCount: sessions.length,
    agentCount: 0,
    runningSessions: 0,
    runningAgents: 0,
  };
  const byDir: Record<string, { sessionCount: number; runningCount: number }> = {};
  for (const s of sessions) {
    const sum = summaries.get(s.sid);
    if (sum) {
      totals.agentCount += sum.agentCount;
      totals.runningAgents += sum.runningCount;
      if (sum.runningCount > 0) totals.runningSessions += 1;
    }
    const dir = s.defaultDir ?? '(no dir)';
    if (!byDir[dir]) byDir[dir] = { sessionCount: 0, runningCount: 0 };
    byDir[dir].sessionCount += 1;
    if (sum && sum.runningCount > 0) byDir[dir].runningCount += 1;
  }
  return { totals, byDir };
}
