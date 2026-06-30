/**
 * Catalog-side agent grouping registry — pure presentation-layer fold.
 *
 * Backdrop:
 * - Server `/api/workbench/agents` returns a FLAT list of 28 agents
 *   (orchestrator + designers + 5 coder personas + 6 art family + 4 reel family
 *    + 4 provider-default coders + ...).
 * - Three relationships are mashed into that flat list:
 *     1. **Skin family** — multiple chat-tone personas that wrap the same
 *        underlying capability (today: coder × 5 — mochi / rin / sakura /
 *        kaede / kumo).
 *     2. **Sub-agent family** — a lead delegates to specialized sub-agents
 *        that share the lead's portrait but have distinct capabilities
 *        (today: iro → 4 art sub-roles; reia → 3 reel sub-roles;
 *         director → sino + mira scene-asset pipeline).
 *     3. **Provider-default coders** — neutral coders bound to a specific CLI
 *        provider (cc-coder / claude-code-default / codex-default /
 *        cursor-default). Their differentiator is the *driver*, not persona
 *        or capability. They're intentionally NOT grouped here — they stay
 *        flat (per user decision 2026-06-22).
 *
 * Surfaces that consume this registry (CATALOG views, per ADR-0019 §9):
 * - `packages/interface/src/components/MainArea/WorkbenchMode.tsx` (AgentsMainArea)
 * - `packages/marketplace/plugins/wb-agent-persona/index.html` (left list).
 *   The iframe inlines a JS copy of this registry — when you change groups
 *   here, mirror in the iframe (search GROUP_REGISTRY).
 * - `packages/interface/src/components/SettingsPanel/SectionsRegister.tsx`
 *   (AgentsBody): groups same-family agents under one section divider with
 *   members indented, but every row keeps its own install/uninstall
 *   checkbox — grouping is purely visual, the toggle granularity stays
 *   per-agent (2026-06-22 user decision).
 *
 * Surfaces that DO NOT use this registry (kept flat by design, per ADR-0019 §9):
 * - `Sidebar/AgentsPanel.tsx` — runtime spawned instances, not catalog.
 * - `Composer` @-mention dropdown — power-user must @ any real id.
 * - `ChatAgentCapsule.tsx` — explicitly left flat per 2026-06-22 decision
 *   (group fold deferred to a separate pass with capsule-specific popover UX).
 *
 * Hard constraint (ADR-0019 §9):
 * - Server / store / setTabAgent / EventBus / useAgentAvatarState all keep
 *   dealing in real agent IDs. No "virtual group agent" leaks anywhere.
 */

export type AgentGroupKind = 'skin' | 'subagent-family';

export interface SkinGroup {
  id: string;
  kind: 'skin';
  /** Card title for the collapsed group head. */
  label: string;
  /** Card subtitle / role label. */
  sublabel: string;
  /**
   * Agent id whose avatar / persona is shown when no member is currently active.
   * Must be one of `memberIds`.
   */
  representativeId: string;
  /** Real agent ids in the order they should appear inside the popover / chip row. */
  memberIds: string[];
  /**
   * Provider-default coders bound to specific CLI drivers (e.g. cc-coder
   * for the claude-code driver, codex-default for Codex). They share the "coder"
   * capability with the skins above but differ by DRIVER instead of by
   * persona. Folded into the same group card so the catalog reads as
   * "one coder family with N tone variants and M driver variants".
   *
   * Not in any way addressable through skin chips — clicking a provider
   * mini-card is a separate, heavier action (switching driver via
   * openAgentDetail). Forgeax-default is intentionally NOT here because
   * its declared role is `planner`, not `coder` (2026-06-22 decision).
   */
  providerDefaultIds?: string[];
}

export interface SubagentFamilyGroup {
  id: string;
  kind: 'subagent-family';
  /** Real agent id of the lead (the user-facing entry point that delegates). */
  leadId: string;
  /** Real agent ids of the sub-specialists (in display order). */
  memberIds: string[];
}

export type AgentGroup = SkinGroup | SubagentFamilyGroup;

/**
 * Group registry. Order doesn't matter (each surface decides its own layout);
 * what matters is which real agent ids participate.
 *
 * ⚠️ When you change this, mirror the change inside
 * `packages/marketplace/plugins/wb-agent-persona/index.html` — search for
 * GROUP_REGISTRY there. Sources of truth for the iframe and React side are
 * independent because the iframe is a separate bundle.
 */
export const AGENT_GROUPS: AgentGroup[] = [
  {
    // Producer family — the orchestration tier. `forge` (主线制作人, the
    // manifest main / runtime orchestrator alias) leads, with the two other
    // 制作人/planner-tier agents folded under it. Same visual treatment as the
    // art family (iro → ...), per 2026-06-23 user decision.
    //
    // ⚠️ `forge` is a runtime alias that only appears in
    // `/api/workbench/agents` — it is NOT a real plugin, so it is absent from
    // `/api/bus/plugins?kind=agent` which feeds the wb-agent-persona iframe.
    // There the group degrades to lead=`arin` (see that file's GROUP_REGISTRY).
    id: 'producer-family',
    kind: 'subagent-family',
    leadId: 'forge',
    memberIds: ['arin', 'forgeax-default'],
  },
  {
    id: 'coder-skins',
    kind: 'skin',
    label: '程序员',
    sublabel: '5 种人格皮肤 + 4 个 CLI 驱动',
    representativeId: 'mochi',
    memberIds: ['mochi', 'rin', 'sakura', 'kaede', 'kumo'],
    providerDefaultIds: ['cc-coder', 'claude-code-default', 'codex-default', 'cursor-default'],
  },
  {
    id: 'art-family',
    kind: 'subagent-family',
    leadId: 'iro',
    memberIds: [
      'animator-2d',
      'character-designer-2d',
      'vfx-artist-3d',
      'lowpoly',
    ],
  },
  {
    id: 'reel-family',
    kind: 'subagent-family',
    leadId: 'reia',
    memberIds: ['reel-storyboard', 'reel-video', 'reel-visual', 'reel-editor'],
  },
  {
    // Scene-asset pipeline family — `director` (场景总监, role=orchestrator)
    // drives the scene-asset pipeline, delegating to `sino` (场景构图师) for
    // layout and `mira` (织绘师) for 2D asset generation. Same lead+indented-
    // subs treatment as the art / reel families, per 2026-06-24 user decision.
    // `mira` was moved here out of `art-family`. `director` is a real agent
    // plugin (agent-director), so unlike `producer-family` it does NOT degrade
    // in the wb-agent-persona iframe.
    id: 'scene-pipeline-family',
    kind: 'subagent-family',
    leadId: 'director',
    memberIds: ['sino', 'mira'],
  },
];

export type AgentRole = 'lead' | 'member' | 'provider';

/** Look up the group + role for an agent id, or null if it's not grouped. */
export function groupForAgent(
  agentId: string,
): { group: AgentGroup; role: AgentRole } | null {
  for (const g of AGENT_GROUPS) {
    if (g.kind === 'subagent-family' && g.leadId === agentId) {
      return { group: g, role: 'lead' };
    }
    if (g.memberIds.includes(agentId)) {
      return { group: g, role: 'member' };
    }
    if (g.kind === 'skin' && g.providerDefaultIds?.includes(agentId)) {
      return { group: g, role: 'provider' };
    }
  }
  return null;
}

/**
 * Fold result item used by each catalog surface. Surfaces render each variant
 * with their own visual treatment; the shape just expresses the grouping.
 */
export type CatalogItem<T extends { id: string }> =
  | { kind: 'flat'; agent: T }
  | {
      kind: 'skin-group';
      group: SkinGroup;
      /** Skin members in registry order, filtered to those actually present in `agents`. */
      members: T[];
      /** Provider-default coders in registry order, filtered to present agents. */
      providers: T[];
      /** Agent representing the head visual — active member if active is a group member, else representativeId. */
      head: T;
    }
  | {
      kind: 'subagent-family';
      group: SubagentFamilyGroup;
      lead: T;
      subs: T[];
    };

/**
 * Collapse a flat agent list into catalog items.
 *
 * Position of each group in the output: first occurrence of any group member
 * in the source list. Other group members are removed in-place. Non-grouped
 * agents pass through unchanged.
 *
 * If a group's lead / representative / members are missing from the input
 * list (e.g. uninstalled), the group is degraded:
 * - subagent-family without lead present → group dropped (members shown flat)
 * - skin group without representative present → first available member becomes head
 * - any group with 0 members present → dropped
 */
export function foldAgents<T extends { id: string }>(
  agents: T[],
  opts: { activeId?: string | null } = {},
): CatalogItem<T>[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const consumed = new Set<string>();
  const out: CatalogItem<T>[] = [];

  for (const agent of agents) {
    if (consumed.has(agent.id)) continue;
    const link = groupForAgent(agent.id);
    if (!link) {
      out.push({ kind: 'flat', agent });
      continue;
    }
    const { group } = link;

    if (group.kind === 'skin') {
      // Skin: gather all skin members AND provider-default coders present
      // for this group. Both end up consumed into the same skin-group card
      // (skins as a chip row, providers as nested mini-cards below).
      const presentMembers = group.memberIds
        .map((id) => byId.get(id))
        .filter((a): a is T => Boolean(a));
      const presentProviders = (group.providerDefaultIds ?? [])
        .map((id) => byId.get(id))
        .filter((a): a is T => Boolean(a));
      if (presentMembers.length === 0) {
        // No skin members → degrade: render the agent we're currently on
        // (which must be a provider since memberIds didn't match) as flat
        // and let the outer loop handle the rest.
        out.push({ kind: 'flat', agent });
        continue;
      }
      const activeId = opts.activeId ?? null;
      const headFromActive = activeId
        ? presentMembers.find((m) => m.id === activeId) ?? null
        : null;
      const headFromRep = byId.get(group.representativeId) ?? null;
      const head = headFromActive ?? headFromRep ?? presentMembers[0]!;
      out.push({
        kind: 'skin-group',
        group,
        members: presentMembers,
        providers: presentProviders,
        head,
      });
      for (const m of presentMembers) consumed.add(m.id);
      for (const p of presentProviders) consumed.add(p.id);
      continue;
    }

    // subagent-family
    const lead = byId.get(group.leadId);
    const presentSubs = group.memberIds
      .map((id) => byId.get(id))
      .filter((a): a is T => Boolean(a));
    if (!lead) {
      // Lead uninstalled / missing — fall back to flat rendering for all members.
      out.push({ kind: 'flat', agent });
      continue;
    }
    if (presentSubs.length === 0) {
      // Group has no subs present — just render lead as a regular flat card.
      out.push({ kind: 'flat', agent: lead });
      consumed.add(lead.id);
      continue;
    }
    out.push({ kind: 'subagent-family', group, lead, subs: presentSubs });
    consumed.add(lead.id);
    for (const m of presentSubs) consumed.add(m.id);
  }
  return out;
}
