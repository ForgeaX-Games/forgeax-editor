// P3.35 — agent role-tribe map fetcher shared by Dashboard RunsList /
// ThreadsList. Pulls /api/workbench/agents once on mount (no polling — role
// taxonomy is static between marketplace edits), folds both `agents[]`
// (marketplace) and `agents_from_bus[]` (Bus host) into a single id → tribe
// key Map.
//
// Tribe key extraction mirrors AgentsPanel/AgentSwitcher's roleKey: split on
// `·` and lowercase the leading segment. Bus agents may carry the synonym
// `coder` for `coding` — normalize so a single CSS rule family
// (.dash-agent-cell-dot.r-coding) lights up both surfaces.

export type AgentRoleMap = ReadonlyMap<string, string>;

const ROLE_ALIAS: Readonly<Record<string, string>> = {
  coder: 'coding',
};

interface AgentsRaw {
  agents?: Array<{ id: string; role: string }>;
  agents_from_bus?: Array<{ id: string; role: string }>;
}

function tribeKey(raw: string): string {
  const head = (raw.split('·')[0] ?? '').trim().toLowerCase();
  return ROLE_ALIAS[head] ?? head;
}

export async function fetchAgentRoleMap(): Promise<AgentRoleMap> {
  const r = await fetch('/api/workbench/agents');
  if (!r.ok) throw new Error(`GET /api/workbench/agents → ${r.status}`);
  const j = (await r.json()) as AgentsRaw;
  const out = new Map<string, string>();
  // Bus first, marketplace overrides — marketplace role labels are richer
  // (`coding · 占位` vs bus `coder`) and the visible Sidebar list uses them.
  for (const a of j.agents_from_bus ?? []) {
    if (a?.id && a.role) out.set(a.id, tribeKey(a.role));
  }
  for (const a of j.agents ?? []) {
    if (a?.id && a.role) out.set(a.id, tribeKey(a.role));
  }
  return out;
}
