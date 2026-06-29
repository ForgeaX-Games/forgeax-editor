// P2.6d — Bus admin panel: full visibility into what the bus actually loaded.
// Top-level mode, mounted by MainArea when store.mode === 'bus'. Lists every
// plugin returned by GET /api/bus/plugins, grouped by `kind`, with one row per
// plugin: id / displayName.zh / version / workbench info (icon + panelSize +
// position) when applicable, plus an experimental flag chip.
//
// P2.6e — adds a filter bar above the groups: one colored chip per kind (with
// count) acting as a toggle (first click solos that kind, repeat-click brings
// "all on" back), and a substring search input matching id + displayName.
// Reset button collapses both back to the initial "show everything" state.
//
// P2.6f — row click expands an inline detail panel: chevron column toggles
// between ▸ (collapsed) and ▾ (expanded); expanded rows insert a colSpan row
// below with full zh + en descriptions (no line-clamp), the canonical manifest
// id rendered as plugins-dir hint, full workbench manifest dump, and a note
// about provides[]/broken[] still being P3 territory. Expanded ids persist
// across filter/search changes so the player can "search → expand → narrow
// further" without losing place.
//
// P2.6g — when the slim shape exposes `provides.{skills,tools,events,
// cliProvider}` (server side projects file-path-stripped subsets), render a
// "provides" section in the detail row: skills → `id · trigger` rows, tools
// → `id [exposedToAI]` rows, events → `name` rows, cliProvider → models +
// 5 boolean capability chips. The note about provides[] no longer being
// exposed now applies only to broken[].
//
// P4.34 — for the agent KindSection, render a violet (#c4a3ff — agent
// tribe color matching ts-agent / cp-agent / tb-agent family) health LED
// between .ba-kind-count and .ba-kind-desc, reading `N reg · M/K run`.
// Driven by polling listBusPlugins('agent') + dashApi.daemons.list() in
// lockstep every 10s; tone is ok (≥1 daemon running) / warn (registered
// but 0 running) / down (registered = 0 or fetch failed) / loading. This
// is the 3rd Bus admin section LED (after cli-provider P4.14 +
// workbench P4.33), bringing section LED coverage to 3/5 kinds.
//
// P3.21 — for the cli-provider KindSection only, render a sticky compact
// capability matrix between the kind header and the table. 4 cli × 5
// capability grid (streaming/thinking/toolCalls/subAgents/sessions) lets the
// player compare row-by-row without expanding every detail row. Column
// headers carry per-cap coverage badges ("4/4 ●"), row headers carry the cli
// displayName + provider id mono code. ●=on (#d4ff48 lime · sky-blue fill on
// header) / ○=off (dim gray). When all caps for all cli are on, the bottom
// summary turns lime "5 cap · 100% coverage"; partial coverage shifts to
// amber for visual alarm. This is the first matrix-style data viz in the
// Bus panel (provides block is per-cli vertical) — 4×5 dense grid is a new
// visual primitive for the panel.
//
// P4.38 — Bus kind mini-dashboard (ba-mini-dashboard). Inserted just under the
// `.ba-head` title row (above `.ba-ui-surfaces` and `.ba-filterbar`) so the
// player landing on ⌘3 Bus admin sees a one-row, zero-scroll snapshot of all
// 6 bus kinds before any group rolls into view: 6 colored mini-LED pills
// (workbench lime · agent violet · cli-provider sky-blue / amber when not all
// ok · model-binding teal · skill gold · tool orange) each reading `<dot>
// <KIND> <ok/total>`. Tones reuse the 6 section-LED snapshots already polled
// at panel level (cliProv / wbSurfaces / agentSnap / mbSnap / skillSnap /
// toolSnap from P4.14/33/34/35/36/37) — no new endpoint, no extra poll, no
// new store key. Click a pill → solo that kind (same semantics as ba-chip
// solo: first click solos, repeat click resets to all); also fires
// setPendingSidebarKindFlash(kind) so the Sidebar BUS KINDS chip flashes in
// sympathy (P3.38 reverse-echo channel). Hover title surfaces the same
// multi-line breakdown each section LED already exposes, so the player can
// read "which workbench panels are mounted / which providers are healthy /
// which agent daemons are running / which skills/tools are experimental"
// without scrolling to that section's header. Completes the BusAdminPanel
// section-LED 6/6 collection (P4.14 → P4.37 across 23 phases) by giving
// those LEDs a unified header dashboard surface.
//
// P4.40 — Bus kind mini-dashboard tail "aggregate summary pill"
// (`.ba-md-summary`). Sits to the right of the 6 LEDs and reads the same
// `leds` descriptor list to bucket each LED into one of four tones:
// `loading / ok / warn / down`. Renders `N ✓ · M ⚠ · K ✗` (loading-only
// state falls back to `…`) with the same per-tone color grammar the 6 LEDs
// already use (ok lime · warn amber · down red), and gives the player a
// 0-scroll, no-hover answer to "how is the bus overall?" without having to
// scan all 6 LEDs. Outer ring color reflects the worst tone present —
// down > warn > loading > ok — so degraded bus state visually alarms.
// Click → resetFilters() (clears kind solo + clears the search query), so
// the pill also doubles as a one-tap "back to everything" escape hatch
// after the player has soloed a kind via any of the 6 LEDs / ba-chip /
// Sidebar BUS KINDS / TabStrip ts-*-chip / TopBar tb-* / PreviewToolbar
// pt-* / ChatPanel cp-* deep-links. When `enabledKinds` is non-null (i.e.
// player currently has at least one kind soloed), the trailing arrow
// glyph swaps `↺ → ⤺` to signal "this click will UNDO that filter" rather
// than just refresh. 0 server / 0 store / 0 marketplace changes · 0 new
// endpoint · 0 new poll — fully derived from the 6 snapshots already at
// panel scope (cliProv / wbSurfaces / agentSnap / mbSnap / skillSnap /
// toolSnap).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation, type TFunction } from '@/i18n';
import { listBusPlugins, pickLang, type BusPluginInfo } from '../../lib/bus-api';
import { dashApi, type ProviderHealth } from '../../lib/dashboard-api';
import { useAppStore } from '../../store';
import './BusAdminPanel.css';

// P4.14 — health roll-up for the cli-provider KindSection header LED.
// Mirrors TopBar tb-providers / PreviewToolbar pt-prov (P4.3/P4.7): polls
// /api/cli-providers every 10s; tone = ok (all healthy lime) / warn (1+ down
// amber) / down (all down red) / loading (gray pulse). Lives only inside the
// cli-provider section so we don't claim health for kinds where the bus has
// no health channel yet.
type ProvHealthTone = 'loading' | 'ok' | 'warn' | 'down';
interface CliProvSnapshot {
  tone: ProvHealthTone;
  ok: number;
  total: number;
  rows: ProviderHealth[];
}

// P4.33 — health roll-up for the **workbench** KindSection header LED.
// Lives only inside the workbench section (kind === 'workbench'). Polls
// /api/bus/ui/surfaces every 10s and counts plugin-layer surfaces whose
// id starts with `${wb.id}.` for each workbench plugin in `group.items`.
// Tone: ok (lime) when at least one wb panel is currently mounted (player
// has visited that tab), warn (amber) when zero wb panels are mounted but
// the registry has ≥1 plugin (typical lazy-load state — player hasn't
// opened any wb tab yet so the mount counter is empty), down (red) when
// the surfaces fetch failed entirely, loading (gray pulse) during the
// first tick. Mirrors P4.14 cli-provider LED pattern but driven off the
// host-level UI-surfaces registry rather than per-provider health. The
// hover title lists every wb plugin and a ✓ / · marker for whether its
// panel surface is currently registered, so the player can see *which*
// panels are live without leaving the section. Counts use the wb id
// (not plugin id) so a future renaming of `@forgeax-plugin/wb-*` won't
// break the mount join.
interface WbSurfacesSnapshot {
  tone: ProvHealthTone;
  mounted: number;
  total: number;
  mountedWbIds: Set<string>;
}

// P4.34 — health roll-up for the **agent** KindSection header LED. After the
// daemon subsystem was retired (R3) this LED only reads the registered agent
// plugin count from `/api/bus/plugins?kind=agent`. Tone: ok (violet) when
// ≥1 agent plugin is registered; down (red) on fetch failure or 0 plugins;
// loading on first paint. The warn-amber state ("registered but no daemon
// running") no longer applies — agents now run inside session contexts via
// the EventBus, not as long-lived daemon processes.
interface AgentSnapshot {
  tone: ProvHealthTone;
  registered: number;
  agentIds: string[];
}

// P4.35 — health roll-up for the **model-binding** KindSection header LED.
// Joins `/api/bus/plugins?kind=model-binding` (registered model-binding plugins
// · today only `@forgeax-plugin/model-anthropic-text`) with `/api/cli-providers`
// via a static vendor→provider map: anthropic → claude-code, openai → codex,
// cursor → cursor-agent, forgeax → forgeax. A binding is "live" when its mapped
// provider's health.ok is true. Tone: ok (teal #7be7c4 — model-binding tribe
// color matching .ba-kind-tag.k-model-binding / .ba-chip.k-model-binding) when
// ≥1 binding is live; warn (amber) when registered ≥1 but live = 0; down (red)
// when fetch failed or registered = 0; loading on first paint. 4th of 5 Bus
// admin section LEDs (after cli-provider P4.14 + workbench P4.33 + agent P4.34).
interface ModelBindingSnapshot {
  tone: ProvHealthTone;
  registered: number;
  live: number;
  bindings: Array<{
    id: string;
    vendor: string;
    channel: string;
    providerId: string | null; // null = vendor unmapped (no provider mapping)
    healthy: boolean;
    detail?: string;
  }>;
}

// Static vendor → cli-provider id map used by the model-binding section LED.
// Kept inline (not exported) because the mapping is a UI-side rendering hint,
// not a runtime contract. New vendors fall through to providerId=null which
// the LED reports as "unmapped" without claiming health.
const VENDOR_TO_PROVIDER: Record<string, string> = {
  anthropic: 'claude-code',
  openai: 'codex',
  cursor: 'cursor-agent',
  forgeax: 'forgeax',
};

// P4.36 — health roll-up for the **skill** KindSection header LED. Skill
// plugins expose a `skills: [{id, trigger}]` array (slash commands made
// available to agents). A skill plugin is "ready" when it registered ≥1
// trigger, "experimental" when manifest carries `experimental: true` (today
// every skill plugin is a placeholder — `@forgeax-plugin/skill-make-game-design`
// has 1 trigger but experimental:true so it lands warn-amber). Tone: ok
// (gold #ffc878 — skill tribe color matching .ba-kind-tag.k-skill /
// .ba-chip.k-skill / .ba-backlink-kind.k-skill) when ≥1 ready & not all
// experimental; warn (amber) when ready < registered OR all are
// experimental; down (red) when registered = 0 or fetch failure; loading
// on first paint. 5th of 5 Bus admin section LEDs (cli-provider P4.14 +
// workbench P4.33 + agent P4.34 + model-binding P4.35); leaves only `tool`
// for the 5/5 → 6/6 collection ceiling (note `tool` slot in KIND_ORDER
// brings total to 6).
interface SkillSnapshot {
  tone: ProvHealthTone;
  registered: number;
  ready: number;
  experimental: number;
  skills: Array<{
    id: string;
    triggers: string[];
    experimental: boolean;
    ready: boolean;
  }>;
}

// P4.37 — health roll-up for the **tool** KindSection header LED. Closes the
// BusAdminPanel section-LED collection at 6/6 (cli-provider P4.14 + workbench
// P4.33 + agent P4.34 + model-binding P4.35 + skill P4.36 + tool P4.37). Tool
// plugins expose `tools: [{id, exposedToAI?}]` (in-process worker invocations
// callable from agents) + an optional `events: [{name}]` array (event names
// the plugin emits on bus). A tool plugin is "ready" when it registered ≥1
// tool, "AI-exposed" when at least one tool has exposedToAI !== false,
// "experimental" when manifest carries `experimental: true` (today the lone
// tool plugin `@forgeax-plugin/tool-balance-resim` is experimental:true with
// 1 tool `balance:resim` + 1 event `balance.resim.completed` so it lands
// warn-amber by the same rules used for skill). Tone: ok (orange #ff8c42 —
// tool tribe color matching .ba-kind-tag.k-tool / .ba-chip.k-tool /
// cb-tl-strip P3.84) when ≥1 ready & not all experimental; warn (amber)
// when ready < registered OR all are experimental; down (red) when
// registered = 0 or fetch failure; loading on first paint. Single-channel
// poll (listBusPlugins('tool')) — tools have no per-binding runtime health
// channel today, same shape as skill snapshot.
interface ToolSnapshot {
  tone: ProvHealthTone;
  registered: number;
  ready: number;
  exposedAi: number;
  experimental: number;
  tools: Array<{
    id: string;
    toolIds: string[];
    eventNames: string[];
    aiExposed: number;
    experimental: boolean;
    ready: boolean;
  }>;
}

interface KindGroup {
  kind: string;
  items: BusPluginInfo[];
}

// P-UI-SURFACES — slim shape of GET /api/bus/ui/surfaces response items.
// Mirrors the relevant fields from packages/server/src/bus/ui-surfaces.ts
// (UISurfaceRecord) without importing — server is the source of truth.
interface UiSurfaceAction {
  id: string;
  exposedToAI?: boolean;
}
interface UiSurfaceRow {
  id: string;
  layer: 'host' | 'plugin' | 'iframe';
  pluginId?: string;
  exposedToAI: boolean;
  actions: UiSurfaceAction[];
  mountedAt: number;
  updatedAt: number;
}
interface UiSurfaceListResponse {
  count: number;
  items: UiSurfaceRow[];
}

// Stable kind ordering — workbench first (the player's most-edited surface),
// then agent (next most-touched), then everything else alphabetical. Unknown
// kinds bucket to the end via the +1000 fallback.
const KIND_ORDER: Record<string, number> = {
  workbench: 10,
  agent: 20,
  'cli-provider': 30,
  'model-binding': 40,
  skill: 50,
  tool: 60,
};

function groupByKind(items: BusPluginInfo[]): KindGroup[] {
  const m = new Map<string, BusPluginInfo[]>();
  for (const it of items) {
    const list = m.get(it.kind) ?? [];
    list.push(it);
    m.set(it.kind, list);
  }
  const groups: KindGroup[] = [];
  for (const [kind, list] of m) {
    list.sort((a, b) => a.id.localeCompare(b.id));
    groups.push({ kind, items: list });
  }
  groups.sort((a, b) => {
    const oa = KIND_ORDER[a.kind] ?? 1000;
    const ob = KIND_ORDER[b.kind] ?? 1000;
    if (oa !== ob) return oa - ob;
    return a.kind.localeCompare(b.kind);
  });
  return groups;
}

// P2.6e — substring match against id + displayName.zh + displayName.en. Case
// insensitive, '' = match all. Keeps the table dense so the player can type
// 'wb' to see workbenches, 'cli' to see cli-providers, 'anim' to jump to one.
function matchesQuery(p: BusPluginInfo, q: string): boolean {
  if (!q) return true;
  const hay = [
    p.id,
    pickLang(p.displayName, 'zh', ''),
    pickLang(p.displayName, 'en', ''),
  ]
    .join(' ')
    .toLowerCase();
  return hay.includes(q.toLowerCase());
}

export function BusAdminPanel() {
  const { t } = useTranslation();
  const [items, setItems] = useState<BusPluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [refreshTs, setRefreshTs] = useState(Date.now());
  const [query, setQuery] = useState('');
  // null = "all kinds on"; Set = explicit kinds enabled. Toggling the first
  // chip switches into explicit mode with that single kind enabled (single
  // click = focus that kind), then further clicks add/remove.
  const [enabledKinds, setEnabledKinds] = useState<Set<string> | null>(null);
  // P2.6f — which plugin ids are currently expanded. Persisted across filter
  // changes (re-typing search shouldn't collapse what you opened). Refresh
  // (re-fetch) clears it so stale rows can't linger expanded.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  // P-UI-SURFACES — read-only view of /api/bus/ui/surfaces. The P9 dual-modality
  // work has the server registering UI surfaces (host.sidebar + plugin-layer
  // surfaces like character-forge.editor) with `actions[]` exposed to AI. No
  // existing panel surfaces this registry, so the player can't see what AI
  // can actually drive at runtime. We render a compact strip between the head
  // and the kind filter bar listing each surface + its action count.
  const [uiSurfaces, setUiSurfaces] = useState<UiSurfaceRow[] | null>(null);
  // P4.14 — cli-provider health snapshot. Inlines the same 10s poll that
  // TopBar tb-providers and PreviewToolbar pt-prov already run; the LED ends
  // up in the cli-provider KindSection header so the player reading the bus
  // panel sees the same ok/warn/down signal without leaving the section.
  const [cliProv, setCliProv] = useState<CliProvSnapshot>({
    tone: 'loading',
    ok: 0,
    total: 0,
    rows: [],
  });
  // P4.33 — workbench section LED snapshot. Refilled by polling
  // /api/bus/ui/surfaces every 10s; the `total` field is overlaid with the
  // current `group.items.length` of the workbench section at render time, so
  // the header always reads `mounted/total` against the live registry rather
  // than a snapshot total taken once at fetch time.
  const [wbSurfaces, setWbSurfaces] = useState<WbSurfacesSnapshot>({
    tone: 'loading',
    mounted: 0,
    total: 0,
    mountedWbIds: new Set(),
  });
  // P4.34 — agent section LED snapshot. After daemon retirement, only the
  // registered plugin count drives this LED. Tone: ok (violet) when ≥1
  // agent plugin is registered, down (red) on fetch failure or 0 plugins.
  const [agentSnap, setAgentSnap] = useState<AgentSnapshot>({
    tone: 'loading',
    registered: 0,
    agentIds: [],
  });
  // P4.35 — model-binding section LED snapshot. Refilled by polling 2 endpoints
  // in lockstep every 10s: listBusPlugins('model-binding') gives the registered
  // bindings + vendor/channel/models; dashApi.providers() gives per-provider
  // health.ok. We join via VENDOR_TO_PROVIDER (anthropic → claude-code etc).
  // Tone classification mirrors P4.34 agent: live ≥ 1 ⇒ ok-teal; registered ≥ 1
  // but live = 0 ⇒ warn-amber (registry has bindings but no underlying CLI is
  // healthy); registered = 0 or fetch failure ⇒ down-red.
  const [mbSnap, setMbSnap] = useState<ModelBindingSnapshot>({
    tone: 'loading',
    registered: 0,
    live: 0,
    bindings: [],
  });
  // P4.36 — skill section LED snapshot. Refilled by polling
  // listBusPlugins('skill') every 10s. Unlike mb/agent this LED has no
  // second channel — "ready" is derived intra-plugin from skills.length≥1;
  // "experimental" from manifest experimental:true. Lockstep cadence with
  // the other 4 LEDs so all 5 visibly update in the same tick.
  const [skillSnap, setSkillSnap] = useState<SkillSnapshot>({
    tone: 'loading',
    registered: 0,
    ready: 0,
    experimental: 0,
    skills: [],
  });
  // P4.37 — tool section LED snapshot. Same shape as skillSnap (single
  // channel — tool plugins have no per-binding runtime health). Refilled by
  // polling listBusPlugins('tool') every 10s, lockstep with the other 5
  // section LEDs so 6/6 LEDs visibly update in the same tick.
  const [toolSnap, setToolSnap] = useState<ToolSnapshot>({
    tone: 'loading',
    registered: 0,
    ready: 0,
    exposedAi: 0,
    experimental: 0,
    tools: [],
  });
  // P3.57 — roving tabindex focus head for the `.ba-chips` filter row.
  // Arrow keys move this index; Enter/Space (button native) toggle the kind.
  // We pick manual-activate (not auto) because chip click has filter side
  // effect (would surprise keyboard scrubbing). Mirrors P3.50 footer chip
  // manual-Enter mode rather than P3.51/53/54 auto-activate.
  const [chipFocusIdx, setChipFocusIdx] = useState(0);
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // P3.58 — roving tabindex focus head for the table rows (`.ba-table tr`).
  // Flat ordering across all KindSection tables — player presses ↑/↓ to walk
  // the 19 plugins as one stream, transparently crossing kind-section
  // boundaries. Enter/Space toggles expand. Manual-activate (Enter required)
  // — arrow keys only move focus, never toggle, because expand mutates
  // expandedIds + fires P3.40 ChatPanel TabStrip flash (side effects).
  const [focusedRowId, setFocusedRowId] = useState<string | null>(null);
  // P2.7f — deep-link target from Sidebar's BusPluginPlaceholder "在 Bus 详情
  //查看 →" button. Consumed once on mount + whenever it flips non-null, then
  // cleared so a back-and-forth between Sidebar/Bus tab doesn't re-expand
  // (player may have manually collapsed it since).
  const pendingBusExpandId = useAppStore((s) => s.pendingBusExpandId);
  const setPendingBusExpandId = useAppStore((s) => s.setPendingBusExpandId);
  // P3.37 — sister deep-link to pendingBusExpandId: Sidebar BUS KINDS footer
  // chips set this slot + setMode('bus'); consume it here once items have
  // loaded by soloing that kind in the filter row (sets enabledKinds = {kind}),
  // then clear so a back-and-forth doesn't keep re-applying.
  const pendingBusKindFilter = useAppStore((s) => s.pendingBusKindFilter);
  const setPendingBusKindFilter = useAppStore((s) => s.setPendingBusKindFilter);
  // P3.38 — reverse of P3.37. When the player clicks a chip in our local filter
  // row, set this slot so the Sidebar BUS KINDS footer chip pulse-flashes for
  // ~1.5s. Confirms the same kind in the peripheral surface and reinforces
  // "this chip is the cross-surface mate of the one you just clicked".
  const setPendingSidebarKindFlash = useAppStore((s) => s.setPendingSidebarKindFlash);
  // P3.40 — sister flash signal to setPendingSidebarKindFlash but for the
  // ChatPanel TabStrip .ts-bus-chip. Fires every time the player toggles a
  // plugin row (expand OR collapse); TabStrip pulses for ~0.8s. 9th deep-link
  // surface, but distinct from prior 8 because TabStrip lives on the right
  // edge (peripheral confirmation for a click that happens in MainArea's
  // bus table — different visual axis than Sidebar (left edge)).
  const setPendingChatPanelBusFlash = useAppStore((s) => s.setPendingChatPanelBusFlash);
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    listBusPlugins()
      .then((r) => {
        if (cancel) return;
        setItems(r.items);
        setErr(null);
      })
      .catch((e: Error) => {
        if (cancel) return;
        setErr(e.message);
      })
      .finally(() => {
        if (!cancel) setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [refreshTs]);

  // P2.6f — clear expanded rows whenever the player explicitly refreshes; a
  // re-fetch may renumber/replace rows so leaving stale expansion is confusing.
  useEffect(() => {
    setExpandedIds(new Set());
  }, [refreshTs]);

  // P-UI-SURFACES — fetch /api/bus/ui/surfaces. Independent endpoint from the
  // plugin list. Null until first fetch resolves; [] when endpoint is 404
  // (server hasn't shipped P9 yet); populated rows otherwise. Silent failure
  // — the strip just stays hidden, the rest of the panel keeps working.
  useEffect(() => {
    let cancel = false;
    fetch('/api/bus/ui/surfaces')
      .then((r) => (r.ok ? (r.json() as Promise<UiSurfaceListResponse>) : { count: 0, items: [] }))
      .then((j) => {
        if (cancel) return;
        setUiSurfaces(j.items ?? []);
      })
      .catch(() => {
        if (!cancel) setUiSurfaces([]);
      });
    return () => {
      cancel = true;
    };
  }, [refreshTs]);

  // P4.14 — poll /api/cli-providers for the cli-provider section LED.
  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const r = await dashApi.providers();
        if (cancelled) return;
        const rows = r.providers ?? [];
        const ok = rows.filter((p) => p.health?.ok).length;
        const total = rows.length;
        const tone: ProvHealthTone =
          total === 0 ? 'down' : ok === total ? 'ok' : ok === 0 ? 'down' : 'warn';
        setCliProv({ tone, ok, total, rows });
      } catch {
        if (!cancelled) setCliProv({ tone: 'down', ok: 0, total: 0, rows: [] });
      }
    };
    void tick();
    const id = window.setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [refreshTs]);

  // P4.33 — poll /api/bus/ui/surfaces for the workbench section LED. Counts
  // plugin-layer surfaces (layer === 'plugin'); each surface id `<wbId>.<x>`
  // contributes its `wbId` prefix. `mountedWbIds` is the join key against the
  // workbench KindSection items array at render time. Tone classification
  // happens in KindSection (needs the live total from `group.items.length`).
  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const r = await fetch('/api/bus/ui/surfaces');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as {
          count?: number;
          items?: Array<{ id: string; layer?: string }>;
        };
        if (cancelled) return;
        const mounted = new Set<string>();
        for (const s of body.items ?? []) {
          if (s.layer !== 'plugin') continue;
          const dot = s.id.indexOf('.');
          const wbId = dot > 0 ? s.id.slice(0, dot) : s.id;
          if (wbId) mounted.add(wbId);
        }
        setWbSurfaces({
          tone: 'loading', // tone reclassified in KindSection vs live total
          mounted: mounted.size,
          total: 0,
          mountedWbIds: mounted,
        });
      } catch {
        if (!cancelled)
          setWbSurfaces({ tone: 'down', mounted: 0, total: 0, mountedWbIds: new Set() });
      }
    };
    void tick();
    const id = window.setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [refreshTs]);

  // P4.34 — poll registered agent plugins for the agent section LED.
  // Daemon channel deleted (R3 — no more daemon processes); tone reads
  // only `registered ≥ 1` now.
  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const plugins = await listBusPlugins('agent');
        if (cancelled) return;
        const agentIds = plugins.items.map((p) => p.id);
        const tone: ProvHealthTone = agentIds.length === 0 ? 'down' : 'ok';
        setAgentSnap({
          tone,
          registered: agentIds.length,
          agentIds,
        });
      } catch {
        if (!cancelled)
          setAgentSnap({
            tone: 'down',
            registered: 0,
            agentIds: [],
          });
      }
    };
    void tick();
    const id = window.setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [refreshTs]);

  // P4.35 — poll registered model-binding plugins + cli-provider health in
  // lockstep for the model-binding section LED. Mirrors P4.34 agent poll
  // shape: a single Promise.all keeps the snapshot atomic; either fetch
  // failure ⇒ tone='down'. Join key is VENDOR_TO_PROVIDER[binding.vendor];
  // unmapped vendors render as `live=false` but still count toward registered.
  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const [plugins, providers] = await Promise.all([
          listBusPlugins('model-binding'),
          dashApi.providers(),
        ]);
        if (cancelled) return;
        const provRows = providers.providers ?? [];
        const healthById = new Map<string, { ok: boolean; detail?: string }>();
        for (const p of provRows) {
          healthById.set(p.id, { ok: !!p.health?.ok, detail: p.health?.detail });
        }
        const bindings = plugins.items.map((p) => {
          const vendor = p.modelBinding?.vendor ?? '';
          const channel = p.modelBinding?.channel ?? '';
          const providerId = vendor ? (VENDOR_TO_PROVIDER[vendor] ?? null) : null;
          const h = providerId ? healthById.get(providerId) : undefined;
          return {
            id: p.id,
            vendor,
            channel,
            providerId,
            healthy: !!h?.ok,
            detail: h?.detail,
          };
        });
        const live = bindings.filter((b) => b.healthy).length;
        const tone: ProvHealthTone =
          bindings.length === 0 ? 'down' : live >= 1 ? 'ok' : 'warn';
        setMbSnap({ tone, registered: bindings.length, live, bindings });
      } catch {
        if (!cancelled)
          setMbSnap({ tone: 'down', registered: 0, live: 0, bindings: [] });
      }
    };
    void tick();
    const id = window.setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [refreshTs]);

  // P4.36 — poll registered skill plugins every 10s for the skill section
  // LED. Single-channel (no cli-provider / daemon join — skills have no
  // runtime health channel today), but classifies each plugin into
  // ready/experimental buckets so tone amber surfaces "registry has skill
  // plugins but they're all placeholders" without forcing the player to
  // open each row to read the experimental flag.
  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const r = await listBusPlugins('skill');
        if (cancelled) return;
        const skills = r.items.map((p) => {
          const triggers = (p.skills ?? []).map((s) => s.trigger);
          return {
            id: p.id,
            triggers,
            experimental: p.experimental === true,
            ready: triggers.length >= 1,
          };
        });
        const registered = skills.length;
        const ready = skills.filter((s) => s.ready).length;
        const experimental = skills.filter((s) => s.experimental).length;
        const tone: ProvHealthTone =
          registered === 0
            ? 'down'
            : ready < registered || experimental === registered
              ? 'warn'
              : 'ok';
        setSkillSnap({ tone, registered, ready, experimental, skills });
      } catch {
        if (!cancelled)
          setSkillSnap({
            tone: 'down',
            registered: 0,
            ready: 0,
            experimental: 0,
            skills: [],
          });
      }
    };
    void tick();
    const id = window.setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [refreshTs]);

  // P4.37 — poll registered tool plugins every 10s for the tool section LED.
  // Mirrors P4.36 skill poll shape: single-channel (no provider join · tools
  // have no per-binding runtime health today), but classifies each plugin
  // into ready/experimental + counts AI-exposed tools so tone amber surfaces
  // "registry has tools but they're all experimental placeholders" without
  // forcing the player to open each row to read the experimental flag.
  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const r = await listBusPlugins('tool');
        if (cancelled) return;
        const tools = r.items.map((p) => {
          const toolList = p.tools ?? [];
          const eventList = p.events ?? [];
          const aiExposed = toolList.filter((t) => t.exposedToAI !== false).length;
          return {
            id: p.id,
            toolIds: toolList.map((t) => t.id),
            eventNames: eventList.map((e) => e.name),
            aiExposed,
            experimental: p.experimental === true,
            ready: toolList.length >= 1,
          };
        });
        const registered = tools.length;
        const ready = tools.filter((t) => t.ready).length;
        const exposedAi = tools.reduce((n, t) => n + t.aiExposed, 0);
        const experimental = tools.filter((t) => t.experimental).length;
        const tone: ProvHealthTone =
          registered === 0
            ? 'down'
            : ready < registered || experimental === registered
              ? 'warn'
              : 'ok';
        setToolSnap({ tone, registered, ready, exposedAi, experimental, tools });
      } catch {
        if (!cancelled)
          setToolSnap({
            tone: 'down',
            registered: 0,
            ready: 0,
            exposedAi: 0,
            experimental: 0,
            tools: [],
          });
      }
    };
    void tick();
    const id = window.setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [refreshTs]);

  // P2.7f — apply deep-link request once items have loaded. Guard on items.length
  // so the expand attempt waits for the fetch to resolve (otherwise we'd open
  // an id that isn't in the table yet, and the scroll target ref wouldn't exist).
  useEffect(() => {
    if (!pendingBusExpandId) return;
    if (items.length === 0) return;
    const target = pendingBusExpandId;
    setExpandedIds((prev) => {
      const next = new Set(prev);
      next.add(target);
      return next;
    });
    // Defer scroll one frame so the new row + detail row render before we
    // measure their position.
    requestAnimationFrame(() => {
      const row = rowRefs.current.get(target);
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
    setPendingBusExpandId(null);
  }, [pendingBusExpandId, items.length, setPendingBusExpandId]);

  // P3.37 — consume Sidebar footer chip click. Wait until items load so the
  // kind set is non-empty (and the chip filter row is mounted). Soloing a kind
  // mirrors what clicking a chip in the local filter row would do — so the
  // player lands in the same state, with one kind visible across all groups.
  useEffect(() => {
    if (!pendingBusKindFilter) return;
    if (items.length === 0) return;
    const target = pendingBusKindFilter;
    setEnabledKinds(new Set([target]));
    setPendingBusKindFilter(null);
  }, [pendingBusKindFilter, items.length, setPendingBusKindFilter]);

  const toggleExpand = (id: string) => {
    // P3.40 — fire the ChatPanel TabStrip bus-chip flash on every toggle
    // (expand AND collapse). Both directions are "I just touched a bus row";
    // TabStrip dedupes via its own timer reset, so spam-clicking the same row
    // doesn't compound — each click starts a fresh 0.8s pulse from peak.
    setPendingChatPanelBusFlash(id);
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allGroups = useMemo(() => groupByKind(items), [items]);
  // Kind chip metadata is derived from the unfiltered groups so the chip row
  // remains stable as the user types / toggles — counts always reflect "what
  // bus actually loaded", not "what's currently visible".
  const kindStats = useMemo(
    () => allGroups.map((g) => ({ kind: g.kind, count: g.items.length })),
    [allGroups],
  );
  const groups = useMemo(() => {
    return allGroups
      .filter((g) => enabledKinds === null || enabledKinds.has(g.kind))
      .map((g) => ({ kind: g.kind, items: g.items.filter((p) => matchesQuery(p, query)) }))
      .filter((g) => g.items.length > 0);
  }, [allGroups, query, enabledKinds]);
  const visibleCount = useMemo(
    () => groups.reduce((sum, g) => sum + g.items.length, 0),
    [groups],
  );
  const filtered = enabledKinds !== null || query.length > 0;
  // P3.58 — flat ordering of currently-visible plugin ids across all kind
  // sections. Crucial that this is derived from `groups` (filtered view), not
  // `allGroups`, so ↑↓ only walks rows the player can actually see.
  const orderedRowIds = useMemo(
    () => groups.flatMap((g) => g.items.map((p) => p.id)),
    [groups],
  );
  // P3.58 — keep focused row valid as filter/search/refresh churn the visible
  // set. If the previously-focused id was filtered out (or items just loaded),
  // snap to the first visible row so Tab-into-table lands somewhere sensible.
  useEffect(() => {
    if (orderedRowIds.length === 0) {
      if (focusedRowId !== null) setFocusedRowId(null);
      return;
    }
    if (focusedRowId === null || !orderedRowIds.includes(focusedRowId)) {
      setFocusedRowId(orderedRowIds[0]);
    }
  }, [orderedRowIds, focusedRowId]);
  // P3.58 — moveRowFocus is bound per-row in PluginRow.onKeyDown. Cycles via
  // mod-N so ↓ from last wraps to first and ↑ from first wraps to last.
  const moveRowFocus = (currentId: string, key: string) => {
    const n = orderedRowIds.length;
    if (n === 0) return;
    const idx = orderedRowIds.indexOf(currentId);
    if (idx < 0) return;
    let next = idx;
    if (key === 'ArrowDown' || key === 'ArrowRight') next = (idx + 1) % n;
    else if (key === 'ArrowUp' || key === 'ArrowLeft') next = (idx - 1 + n) % n;
    else if (key === 'Home') next = 0;
    else if (key === 'End') next = n - 1;
    else return;
    const nextId = orderedRowIds[next];
    setFocusedRowId(nextId);
    requestAnimationFrame(() => {
      rowRefs.current.get(nextId)?.focus();
    });
  };

  const toggleKind = (kind: string) => {
    // P3.38 — fire the reverse deep-link on every click (not just on solo-in),
    // because the player's mental model is "I touched THIS kind, confirm it
    // over in the Sidebar". Sidebar will reset its own timer if the same chip
    // is clicked rapidly, so spamming doesn't break the animation.
    setPendingSidebarKindFlash(kind);
    setEnabledKinds((prev) => {
      // First click from "all on" → solo that kind (most common UX: "show me
      // just workbench"). Re-click solo'd kind → back to "all on".
      if (prev === null) return new Set([kind]);
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      // If user toggled all kinds back on, snap to null sentinel so the chip
      // row renders the same as initial mount.
      if (next.size === kindStats.length) return null;
      // If user turned every chip off, also snap back to null — empty filter
      // is confusing ("nothing to show"); treat it as "reset".
      if (next.size === 0) return null;
      return next;
    });
  };
  const resetFilters = () => {
    setEnabledKinds(null);
    setQuery('');
  };

  // P4.39 — derive 4-state tone (loading / ok / warn / down) per kind at panel
  // scope so both the mini-dashboard (P4.38 ba-mini-dashboard) and the kind
  // filter chip row (`.ba-chip`) can read from one source of truth. Same logic
  // the IIFE already uses for the mini-dashboard: workbench gets re-derived off
  // mounted-vs-registered (panel-scope wbSurfaces.tone stays 'loading' by
  // design); the other five mirror their snapshot.tone directly. Players see
  // the chip dot + the dashboard LED light up in the same 10s tick.
  const kindTones: Record<string, ProvHealthTone> = (() => {
    const wbRegistered =
      allGroups.find((g) => g.kind === 'workbench')?.items.length ?? 0;
    const wbTone: ProvHealthTone =
      wbSurfaces.tone === 'down'
        ? 'down'
        : wbRegistered === 0
          ? 'down'
          : wbSurfaces.mounted >= 1
            ? 'ok'
            : 'warn';
    return {
      workbench: wbTone,
      agent: agentSnap.tone,
      'cli-provider': cliProv.tone,
      'model-binding': mbSnap.tone,
      skill: skillSnap.tone,
      tool: toolSnap.tone,
    };
  })();

  return (
    <div className="bus-admin">
      <div className="ba-head">
        <div className="ba-title">
          <span className="ba-title-text">{t('bus.title')}</span>
          <span className="ba-title-meta">
            {loading
              ? t('common.loading')
              : filtered
                ? `${visibleCount} / ${items.length} plugin · ${groups.length} kind`
                : `${items.length} plugin · ${allGroups.length} kind`}
          </span>
        </div>
        <button
          className="ba-refresh"
          onClick={() => setRefreshTs(Date.now())}
          title={t('bus.refreshTitle')}
        >
          ↻ {t('bus.refresh')}
        </button>
      </div>
      {!loading && items.length > 0 && (() => {
        // P4.38 — mini-dashboard row. Builds one descriptor per kind reading
        // the 6 snapshots already populated at panel scope. Order matches
        // KIND_ORDER (workbench → agent → cli-provider → model-binding →
        // skill → tool) so it lines up with the section sequence below.
        // Workbench tone reclass — panel-level wbSurfaces.tone stays 'loading'
        // by design (KindSection re-derives against live group total), so the
        // mini-dashboard recomputes here off mounted vs registered counts:
        //   fetch failed → down · registered=0 → down · mounted≥1 → ok ·
        //   registered≥1 but mounted=0 → warn (lazy-load state, no tab opened
        //   yet). Brief first-paint flash shows warn (mounted=0) before the
        //   first poll completes — acceptable, since the section LED has the
        //   same property.
        const wbRegistered = allGroups.find((g) => g.kind === 'workbench')?.items.length ?? 0;
        const wbTone: ProvHealthTone =
          wbSurfaces.tone === 'down'
            ? 'down'
            : wbRegistered === 0
              ? 'down'
              : wbSurfaces.mounted >= 1
                ? 'ok'
                : 'warn';
        const wbCount = `${wbSurfaces.mounted}/${Math.max(wbSurfaces.mounted, wbRegistered)}`;
        const wbTitle =
          wbTone === 'down' && wbSurfaces.tone === 'down'
            ? 'Workbench — fetch failed (/api/bus/ui/surfaces)'
            : `Workbench — ${wbSurfaces.mounted}/${Math.max(wbSurfaces.mounted, wbRegistered)} panels mounted · ${wbRegistered} registered · ${t('bus.mdFocusKind', { kind: 'workbench' })}`;
        const agentCount =
          agentSnap.tone === 'loading'
            ? '…'
            : `${agentSnap.registered}`;
        const agentTitle =
          agentSnap.tone === 'loading'
            ? 'Agent — checking /api/bus/plugins?kind=agent …'
            : `Agent — ${agentSnap.registered} plugin${agentSnap.registered === 1 ? '' : 's'} registered · ${t('bus.mdFocusKind', { kind: 'agent' })}`;
        const provCount = cliProv.tone === 'loading' ? '…/…' : `${cliProv.ok}/${cliProv.total}`;
        const provTitle =
          cliProv.tone === 'loading'
            ? 'CLI Providers — checking /api/cli-providers …'
            : `CLI Providers — ${cliProv.ok}/${cliProv.total} healthy · ${t('bus.mdFocusKind', { kind: 'cli-provider' })}`;
        const mbCount =
          mbSnap.tone === 'loading' ? '…/…' : `${mbSnap.live}/${mbSnap.registered}`;
        const mbTitle =
          mbSnap.tone === 'loading'
            ? 'Model Binding — checking …'
            : `Model Binding — ${mbSnap.live}/${mbSnap.registered} live · ${t('bus.mdFocusKind', { kind: 'model-binding' })}`;
        const skillCount =
          skillSnap.tone === 'loading' ? '…/…' : `${skillSnap.ready}/${skillSnap.registered}`;
        const skillTitle =
          skillSnap.tone === 'loading'
            ? 'Skill — checking …'
            : `Skill — ${skillSnap.ready}/${skillSnap.registered} ready · ${skillSnap.experimental} experimental · ${t('bus.mdFocusKind', { kind: 'skill' })}`;
        const toolCount =
          toolSnap.tone === 'loading' ? '…/…' : `${toolSnap.ready}/${toolSnap.registered}`;
        const toolTitle =
          toolSnap.tone === 'loading'
            ? 'Tool — checking …'
            : `Tool — ${toolSnap.ready}/${toolSnap.registered} ready · ${toolSnap.experimental} experimental · ${t('bus.mdFocusKind', { kind: 'tool' })}`;
        const leds: Array<{
          kind: string;
          label: string;
          tone: ProvHealthTone;
          count: string;
          title: string;
          aria: string;
        }> = [
          { kind: 'workbench', label: 'WB', tone: wbTone, count: wbCount, title: wbTitle, aria: `Workbench ${wbSurfaces.mounted} of ${Math.max(wbSurfaces.mounted, wbRegistered)} panels mounted` },
          { kind: 'agent', label: 'AGENT', tone: agentSnap.tone, count: agentCount, title: agentTitle, aria: `Agent ${agentSnap.registered} plugins registered` },
          { kind: 'cli-provider', label: 'PROV', tone: cliProv.tone, count: provCount, title: provTitle, aria: `CLI Providers ${cliProv.ok} of ${cliProv.total} healthy` },
          { kind: 'model-binding', label: 'MB', tone: mbSnap.tone, count: mbCount, title: mbTitle, aria: `Model Binding ${mbSnap.live} of ${mbSnap.registered} live` },
          { kind: 'skill', label: 'SKILL', tone: skillSnap.tone, count: skillCount, title: skillTitle, aria: `Skill ${skillSnap.ready} of ${skillSnap.registered} ready` },
          { kind: 'tool', label: 'TOOL', tone: toolSnap.tone, count: toolCount, title: toolTitle, aria: `Tool ${toolSnap.ready} of ${toolSnap.registered} ready` },
        ];
        return (
          <div
            className="ba-mini-dashboard"
            role="toolbar"
            aria-label="Bus kind health overview"
          >
            <span className="ba-md-label" aria-hidden>
              {t('bus.healthOverview')}
            </span>
            {leds.map((led) => {
              const soloed = enabledKinds !== null && enabledKinds.size === 1 && enabledKinds.has(led.kind);
              return (
                <button
                  key={led.kind}
                  type="button"
                  className={`ba-md-led ba-md-k-${led.kind} is-${led.tone}${soloed ? ' is-soloed' : ''}`}
                  title={led.title}
                  aria-label={led.aria}
                  aria-pressed={soloed}
                  onClick={() => {
                    setPendingSidebarKindFlash(led.kind);
                    setEnabledKinds((prev) =>
                      prev !== null && prev.size === 1 && prev.has(led.kind)
                        ? null
                        : new Set([led.kind]),
                    );
                  }}
                >
                  <span className="ba-md-dot" aria-hidden />
                  <span className="ba-md-kind">{led.label}</span>
                  <span className="ba-md-count">{led.count}</span>
                </button>
              );
            })}
            {(() => {
              // P4.40 — aggregate health summary pill at the tail of the
              // mini-dashboard. Counts the four tone buckets across the 6
              // kinds (loading / ok / warn / down) and renders `N ✓ · M ⚠ · K ✗`
              // with same color grammar as the LEDs. Outer ring color reflects
              // worst-state: any down → red, else any warn → amber, else any
              // loading → dim, else lime. Click → resetFilters() (clear kind
              // solo + clear query) so the pill doubles as a one-tap "show
              // everything" escape hatch when players have soloed a kind. When
              // all 6 are loading, hides ✓/⚠/✗ counts and shows `…` instead.
              //
              // P4.42 — prepend a `.ba-md-sum-total` cell `Σ{items.length}`
              // before the tone cells. Reads the total registered plugin
              // count straight off `items` (already in scope, same number the
              // panel header `Plugins {items.length}` reads), then a vertical
              // separator `.ba-md-sum-vsep` cleanly splits the «total» band
              // from the «tone bucket» band. Player gets a single hop
              // «Σ20 · 2·4·0 · ↺» summary in the bus dashboard head: 20
              // plugins total, split across 2 ok / 4 warn / 0 down kinds, ↺
              // to reset filters. The Σ cell uses neutral 0.72 white (same
              // as base pill foreground) so it doesn't compete with the
              // colored tone cells visually — it's a quiet «context tag»,
              // not a 4th tone bucket.
              let okN = 0, warnN = 0, downN = 0, loadingN = 0;
              for (const led of leds) {
                if (led.tone === 'ok') okN++;
                else if (led.tone === 'warn') warnN++;
                else if (led.tone === 'down') downN++;
                else loadingN++;
              }
              const worst: ProvHealthTone =
                downN > 0 ? 'down' : warnN > 0 ? 'warn' : loadingN === leds.length ? 'loading' : 'ok';
              const hasSolo = enabledKinds !== null && enabledKinds.size < leds.length;
              const totalPlugins = items.length;
              const ariaLbl =
                loadingN === leds.length
                  ? `Bus kind health — loading · ${totalPlugins} plugins total`
                  : `Bus kind health — ${totalPlugins} plugins total · ${okN} ok, ${warnN} warn, ${downN} down of ${leds.length} kinds`;
              const titleStr =
                loadingN === leds.length
                  ? `Σ ${totalPlugins} plugin · ${t('bus.mdSummaryLoading')}`
                  : `Σ ${totalPlugins} plugin ${t('bus.registered')} · ${okN}/${leds.length} kind ok · ${warnN} warn · ${downN} down · ${t('bus.mdClearFilter')}`;
              return (
                <button
                  type="button"
                  className={`ba-md-summary is-${worst}${hasSolo ? ' has-solo' : ''}`}
                  title={titleStr}
                  aria-label={ariaLbl}
                  onClick={() => resetFilters()}
                >
                  <span className="ba-md-sum-cell ba-md-sum-total" aria-hidden>
                    <span className="ba-md-sum-sigma">Σ</span>
                    {totalPlugins}
                  </span>
                  <span className="ba-md-sum-vsep" aria-hidden />
                  {loadingN === leds.length ? (
                    <span className="ba-md-sum-loading">…</span>
                  ) : (
                    <>
                      <span className="ba-md-sum-cell ba-md-sum-ok" aria-hidden>
                        <span className="ba-md-sum-dot" />
                        {okN}
                      </span>
                      <span className="ba-md-sum-sep" aria-hidden>·</span>
                      <span className="ba-md-sum-cell ba-md-sum-warn" aria-hidden>
                        <span className="ba-md-sum-dot" />
                        {warnN}
                      </span>
                      <span className="ba-md-sum-sep" aria-hidden>·</span>
                      <span className="ba-md-sum-cell ba-md-sum-down" aria-hidden>
                        <span className="ba-md-sum-dot" />
                        {downN}
                      </span>
                    </>
                  )}
                  <span className="ba-md-sum-arrow" aria-hidden>
                    {hasSolo ? '⤺' : '↺'}
                  </span>
                </button>
              );
            })()}
          </div>
        );
      })()}
      {uiSurfaces && uiSurfaces.length > 0 && (
        <div
          className="ba-ui-surfaces"
          aria-label="UI surfaces registered with bus.ui"
        >
          <div className="ba-uis-head">
            <span className="ba-uis-dot" aria-hidden />
            <span className="ba-uis-label">UI Surfaces</span>
            <span
              className="ba-uis-count"
              title="surfaces currently registered with bus.ui"
            >
              {uiSurfaces.length}
            </span>
            <span className="ba-uis-sub">
              registered ·{' '}
              {uiSurfaces.reduce(
                (n, s) =>
                  n + (s.exposedToAI ? s.actions.filter((a) => a.exposedToAI !== false).length : 0),
                0,
              )}{' '}
              actions exposed to AI · <code>/api/bus/ui/surfaces</code>
            </span>
          </div>
          <div className="ba-uis-row">
            {uiSurfaces.map((s) => {
              const aiActions = s.exposedToAI
                ? s.actions.filter((a) => a.exposedToAI !== false).length
                : 0;
              const totalActions = s.actions.length;
              return (
                <div
                  key={s.id}
                  className={`ba-uis-chip layer-${s.layer}${s.exposedToAI ? '' : ' is-dim'}`}
                  title={`${s.layer} surface · ${totalActions} action${totalActions === 1 ? '' : 's'} · ${aiActions} exposed to AI${s.pluginId ? ` · plugin: ${s.pluginId}` : ''}`}
                >
                  <span className="ba-uis-layer">{s.layer}</span>
                  <span className="ba-uis-id">{s.id}</span>
                  <span className="ba-uis-actions">
                    <span className="ba-uis-ai">{aiActions}</span>
                    <span className="ba-uis-sep">/</span>
                    <span className="ba-uis-total">{totalActions}</span>
                    <span className="ba-uis-actions-lbl">actions</span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {!loading && items.length > 0 && (
        <div className="ba-filterbar">
          <div
            className="ba-chips"
            role="tablist"
            aria-orientation="horizontal"
            aria-label={t('bus.filterByKind')}
          >
            <span
              className="ba-kbd"
              aria-hidden="true"
              title={t('bus.kbdNavChips')}
            >
              ←→
            </span>
            {kindStats.map((k, i) => {
              const active = enabledKinds === null || enabledKinds.has(k.kind);
              return (
                <button
                  key={k.kind}
                  ref={(el) => {
                    chipRefs.current[i] = el;
                  }}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  tabIndex={i === chipFocusIdx ? 0 : -1}
                  className={`ba-chip k-${k.kind} ${active ? 'is-on' : 'is-off'}`}
                  onClick={() => {
                    setChipFocusIdx(i);
                    toggleKind(k.kind);
                  }}
                  onKeyDown={(e) => {
                    const n = kindStats.length;
                    if (n === 0) return;
                    let next = i;
                    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                      next = (i + 1) % n;
                    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                      next = (i - 1 + n) % n;
                    } else if (e.key === 'Home') {
                      next = 0;
                    } else if (e.key === 'End') {
                      next = n - 1;
                    } else {
                      return;
                    }
                    e.preventDefault();
                    setChipFocusIdx(next);
                    requestAnimationFrame(() => {
                      chipRefs.current[next]?.focus();
                    });
                  }}
                  title={
                    (enabledKinds === null
                      ? t('bus.chipSolo', { kind: k.kind, count: k.count })
                      : active
                        ? t('bus.chipHide', { kind: k.kind })
                        : t('bus.chipShow', { kind: k.kind })) +
                    ' · ' +
                    t('bus.chipToggleHint')
                  }
                >
                  <span
                    className={`ba-chip-dot is-${kindTones[k.kind] ?? 'loading'}`}
                    aria-hidden="true"
                  />
                  <span className="ba-chip-name">{k.kind}</span>
                  <span className="ba-chip-count">{k.count}</span>
                </button>
              );
            })}
          </div>
          <input
            type="text"
            className="ba-search"
            placeholder={t('bus.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          {filtered && (
            <button
              type="button"
              className="ba-reset"
              onClick={resetFilters}
              title={t('bus.resetTitle')}
            >
              ✕ {t('bus.reset')}
            </button>
          )}
        </div>
      )}
      {err && (
        <div className="ba-error">
          {t('bus.requestFailed', { err })}
        </div>
      )}
      {!err && !loading && items.length === 0 && (
        <div className="ba-empty">{t('bus.emptyNoPlugins')}</div>
      )}
      {!err && !loading && items.length > 0 && groups.length === 0 && (
        <div className="ba-empty">{t('bus.emptyNoMatch')}</div>
      )}
      {!loading && orderedRowIds.length > 0 && (
        <div className="ba-row-kbd-bar" aria-hidden="true">
          <span
            className="ba-kbd"
            title={t('bus.rowKbdTitle')}
          >
            ↑↓
          </span>
          <span className="ba-row-kbd-label">
            {t('bus.rowKbdLabel', { n: orderedRowIds.length })}
          </span>
        </div>
      )}
      {/* P4.86 — one-line kind-glyph legend. Surfaces the same 6-glyph
         alphabet used by P4.83 `.ba-kind-tag::before` (section header pill) /
         P4.84 `.ba-chip-name::before` (filter chip row) / P4.85 `.ba-kind-head`
         box-shadow left strip — so newcomers can decode the symbols at a
         glance instead of having to scroll until they hit a section header.
         Inline-styled so the 5-streak on BusAdminPanel.css isn't extended. */}
      {!loading && items.length > 0 && (
        <div
          className="ba-glyph-legend"
          data-legend="kind-alphabet"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '4px 12px 8px',
            fontSize: 10,
            fontFamily: 'var(--mono, var(--font-mono))',
            color: 'rgba(220,228,235,0.55)',
            letterSpacing: 0.4,
            flexWrap: 'wrap',
          }}
        >
          <span
            style={{
              color: 'rgba(255,255,255,0.30)',
              fontSize: 9,
              textTransform: 'uppercase',
              letterSpacing: 0.7,
              fontWeight: 600,
            }}
          >
            kind glyph alphabet
          </span>
          {[
            { g: '▦', c: 'rgba(212,255,72,0.95)', n: 'workbench' },
            { g: '◆', c: 'rgba(196,163,255,0.95)', n: 'agent' },
            { g: '⌘', c: 'rgba(125,211,252,0.95)', n: 'cli-provider' },
            { g: '◈', c: 'rgba(123,231,196,0.95)', n: 'model-binding' },
            { g: '★', c: 'rgba(255,200,120,0.95)', n: 'skill' },
            { g: '✦', c: 'rgba(255,140,66,0.95)', n: 'tool' },
          ].map((e) => (
            <span
              key={e.n}
              data-kind={e.n}
              style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}
              title={`${e.g} = ${e.n}`}
            >
              <span
                aria-hidden
                style={{ color: e.c, fontWeight: 700, fontSize: 13, lineHeight: 1 }}
              >
                {e.g}
              </span>
              <span style={{ color: 'rgba(220,228,235,0.78)' }}>{e.n}</span>
            </span>
          ))}
        </div>
      )}
      <div className="ba-groups">
        {groups.map((g) => (
          <KindSection
            key={g.kind}
            group={g}
            expandedIds={expandedIds}
            onToggle={toggleExpand}
            rowRefs={rowRefs}
            onFlashKind={setPendingSidebarKindFlash}
            onSoloKind={(k) => setEnabledKinds(new Set([k]))}
            focusedRowId={focusedRowId}
            onSetFocusedRowId={setFocusedRowId}
            onMoveRowFocus={moveRowFocus}
            cliProv={cliProv}
            wbSurfaces={wbSurfaces}
            agentSnap={agentSnap}
            mbSnap={mbSnap}
            skillSnap={skillSnap}
            toolSnap={toolSnap}
          />
        ))}
      </div>
      <div className="ba-footnote">
        {t('bus.footnoteSource')}<code>GET /api/bus/plugins</code> · slim shape · provides.{'{'}workbench / modelBinding /
        skills / tools / events / cliProvider{'}'} {t('bus.footnoteExpanded')} · {t('bus.footnoteBroken')} ·
        {' '}{t('bus.footnoteRowHint')}
      </div>
    </div>
  );
}

interface KindSectionProps {
  group: KindGroup;
  expandedIds: Set<string>;
  onToggle: (id: string) => void;
  rowRefs: React.MutableRefObject<Map<string, HTMLTableRowElement>>;
  onFlashKind: (kind: string) => void;
  onSoloKind: (kind: string) => void;
  focusedRowId: string | null;
  onSetFocusedRowId: (id: string) => void;
  onMoveRowFocus: (currentId: string, key: string) => void;
  cliProv: CliProvSnapshot;
  wbSurfaces: WbSurfacesSnapshot;
  agentSnap: AgentSnapshot;
  mbSnap: ModelBindingSnapshot;
  skillSnap: SkillSnapshot;
  toolSnap: ToolSnapshot;
}

function KindSection({
  group,
  expandedIds,
  onToggle,
  rowRefs,
  onFlashKind,
  onSoloKind,
  focusedRowId,
  onSetFocusedRowId,
  onMoveRowFocus,
  cliProv,
  wbSurfaces,
  agentSnap,
  mbSnap,
  skillSnap,
  toolSnap,
}: KindSectionProps) {
  const { t } = useTranslation();
  // P4.14 — only the cli-provider section gets the health LED (only kind with
  // a real health channel today). Hover title lists every provider's ok/down
  // line so the player can see *why* a tone is amber without leaving the
  // section. Mirrors PreviewMode pt-prov / TopBar tb-providers detail format.
  const showProvLed = group.kind === 'cli-provider';
  const provTitle = showProvLed
    ? cliProv.tone === 'loading'
      ? 'CLI Providers — checking /api/cli-providers …'
      : cliProv.total === 0
        ? 'CLI Providers — none registered'
        : [
            `CLI Providers — ${cliProv.ok}/${cliProv.total} ok`,
            ...cliProv.rows.map(
              (p) =>
                `${p.health?.ok ? '✓' : '✗'} ${p.id}${p.health?.detail ? ' — ' + p.health.detail : ''}`,
            ),
          ].join('\n')
    : undefined;
  const provDisplay = showProvLed
    ? cliProv.tone === 'loading'
      ? '…/…'
      : `${cliProv.ok}/${cliProv.total} ok`
    : '';
  // P4.33 — workbench section LED. Mirrors the cli-provider LED above but
  // joins the polled /api/bus/ui/surfaces mountedWbIds set against the live
  // workbench plugin list (`group.items`). The total `M` is always derived
  // from `group.items.length` so the LED count tracks live bus registry, not
  // the snapshot taken at fetch time. Tone: ok (lime) when ≥1 wb panel is
  // mounted, warn (amber) when 0 mounted with ≥1 registered, down (red)
  // when the fetch failed (state.tone === 'down'), loading otherwise.
  const showWbLed = group.kind === 'workbench';
  const wbTotal = showWbLed ? group.items.length : 0;
  const wbMounted = showWbLed
    ? group.items.reduce((n, p) => {
        const wbId = p.workbench?.id;
        return wbId && wbSurfaces.mountedWbIds.has(wbId) ? n + 1 : n;
      }, 0)
    : 0;
  const wbTone: ProvHealthTone = !showWbLed
    ? 'loading'
    : wbSurfaces.tone === 'down'
      ? 'down'
      : wbSurfaces.tone === 'loading' && wbSurfaces.mountedWbIds.size === 0
        ? 'loading'
        : wbMounted >= 1
          ? 'ok'
          : wbTotal > 0
            ? 'warn'
            : 'loading';
  const wbTitle = showWbLed
    ? wbTone === 'loading'
      ? 'Workbench — checking /api/bus/ui/surfaces …'
      : wbTone === 'down'
        ? 'Workbench — /api/bus/ui/surfaces fetch failed'
        : [
            `Workbench — ${wbMounted}/${wbTotal} panel surfaces mounted`,
            ...group.items.map((p) => {
              const wbId = p.workbench?.id ?? '?';
              const live = wbSurfaces.mountedWbIds.has(wbId);
              return `${live ? '✓' : '·'} ${wbId}  (${p.id})`;
            }),
          ].join('\n')
    : undefined;
  const wbDisplay = showWbLed
    ? wbTone === 'loading'
      ? '…/…'
      : `${wbMounted}/${wbTotal} mounted`
    : '';
  // P4.34 — agent section LED. After daemon retirement (R3), driven only by
  // listBusPlugins('agent') every 10s. Tone is `agentSnap.tone` (ok-violet
  // when ≥1 plugin registered, down-red on 0 or fetch failure).
  const showAgentLed = group.kind === 'agent';
  const agentTitle = showAgentLed
    ? agentSnap.tone === 'loading'
      ? 'Agent — checking /api/bus/plugins?kind=agent …'
      : agentSnap.tone === 'down' && agentSnap.registered === 0
        ? 'Agent — bus fetch failed or no agent plugins registered'
        : [
            `Agent — ${agentSnap.registered} plugin${agentSnap.registered === 1 ? '' : 's'} registered`,
            ...agentSnap.agentIds.map((id) => `✓ ${id}`),
          ].join('\n')
    : undefined;
  const agentDisplay = showAgentLed
    ? agentSnap.tone === 'loading'
      ? '…'
      : `${agentSnap.registered} reg`
    : '';
  // P4.35 — model-binding section LED. Driven by parent BusAdminPanel polling
  // listBusPlugins('model-binding') + dashApi.providers() in lockstep. Tone /
  // counts read directly from mbSnap (computed at fetch time via the
  // vendor→provider map join). Tooltip lists each binding's vendor/channel +
  // mapped provider + health detail so the player can see *why* a binding is
  // warn (e.g. "anthropic→claude-code: cli not installed").
  const showMbLed = group.kind === 'model-binding';
  const mbTitle = showMbLed
    ? mbSnap.tone === 'loading'
      ? 'Model Binding — checking /api/bus/plugins?kind=model-binding + /api/cli-providers …'
      : mbSnap.tone === 'down' && mbSnap.registered === 0
        ? 'Model Binding — none registered (or bus/cli-providers fetch failed)'
        : [
            `Model Binding — ${mbSnap.registered} registered · ${mbSnap.live}/${mbSnap.registered} live`,
            ...mbSnap.bindings.map((b) => {
              const mark = b.healthy ? '✓' : b.providerId ? '·' : '?';
              const route = b.providerId
                ? `${b.vendor}→${b.providerId}`
                : `${b.vendor}→(unmapped)`;
              const tail = b.healthy
                ? ' [live]'
                : b.providerId
                  ? ` [down${b.detail ? ' — ' + b.detail : ''}]`
                  : ' [no provider mapping]';
              return `${mark} ${b.id}  (${route}/${b.channel || '?'})${tail}`;
            }),
          ].join('\n')
    : undefined;
  const mbDisplay = showMbLed
    ? mbSnap.tone === 'loading'
      ? '…/…'
      : `${mbSnap.live}/${mbSnap.registered} live`
    : '';
  // P4.36 — skill section LED. Single-channel poll (listBusPlugins('skill'))
  // exposed via parent BusAdminPanel as skillSnap. Tooltip lists each skill
  // plugin's id + its registered trigger(s) + a [stable]/[experimental]/
  // [no triggers] tail so the player can see *why* a tone is warn (today
  // typically "1 experimental" because the lone skill plugin is the
  // make-game-design placeholder marked experimental:true) without
  // expanding the row.
  const showSkillLed = group.kind === 'skill';
  const skillTitle = showSkillLed
    ? skillSnap.tone === 'loading'
      ? 'Skill — checking /api/bus/plugins?kind=skill …'
      : skillSnap.tone === 'down' && skillSnap.registered === 0
        ? 'Skill — none registered (or bus fetch failed)'
        : [
            `Skill — ${skillSnap.registered} registered · ${skillSnap.ready}/${skillSnap.registered} ready · ${skillSnap.experimental} experimental`,
            ...skillSnap.skills.map((s) => {
              const mark = !s.ready ? '✗' : s.experimental ? '⚠' : '✓';
              const trig = s.triggers.length > 0 ? s.triggers.join(' ') : '(no triggers)';
              const tail = !s.ready
                ? ' [no triggers]'
                : s.experimental
                  ? ' [experimental]'
                  : ' [stable]';
              return `${mark} ${s.id}  (${trig})${tail}`;
            }),
          ].join('\n')
    : undefined;
  const skillDisplay = showSkillLed
    ? skillSnap.tone === 'loading'
      ? '…/…'
      : `${skillSnap.ready}/${skillSnap.registered} ready`
    : '';
  // P4.37 — tool section LED. Single-channel poll exposed via parent
  // BusAdminPanel as toolSnap. Tooltip lists each tool plugin's id, its
  // registered tool ids (e.g. `balance:resim`), event names emitted, and a
  // [stable]/[experimental]/[no tools] tail so the player can see *why* the
  // tone is warn (today typically "1 experimental" because the lone tool
  // plugin tool-balance-resim is the placeholder marked experimental:true)
  // without expanding the row. Closes the BusAdminPanel section-LED grid
  // at 6/6.
  const showToolLed = group.kind === 'tool';
  const toolTitle = showToolLed
    ? toolSnap.tone === 'loading'
      ? 'Tool — checking /api/bus/plugins?kind=tool …'
      : toolSnap.tone === 'down' && toolSnap.registered === 0
        ? 'Tool — none registered (or bus fetch failed)'
        : [
            `Tool — ${toolSnap.registered} registered · ${toolSnap.ready}/${toolSnap.registered} ready · ${toolSnap.exposedAi} AI-exposed · ${toolSnap.experimental} experimental`,
            ...toolSnap.tools.map((t) => {
              const mark = !t.ready ? '✗' : t.experimental ? '⚠' : '✓';
              const ids = t.toolIds.length > 0 ? t.toolIds.join(' ') : '(no tools)';
              const evtTail =
                t.eventNames.length > 0 ? ` · emits: ${t.eventNames.join(' ')}` : '';
              const tail = !t.ready
                ? ' [no tools]'
                : t.experimental
                  ? ' [experimental]'
                  : ' [stable]';
              return `${mark} ${t.id}  (${ids})${evtTail}${tail}`;
            }),
          ].join('\n')
    : undefined;
  const toolDisplay = showToolLed
    ? toolSnap.tone === 'loading'
      ? '…/…'
      : `${toolSnap.ready}/${toolSnap.registered} ready`
    : '';
  return (
    <section className="ba-kind">
      <header className="ba-kind-head">
        <button
          type="button"
          className={`ba-kind-tag k-${group.kind} is-link`}
          onClick={() => onFlashKind(group.kind)}
          title={t('bus.kindTagFlashTitle', { kind: group.kind })}
        >
          {group.kind}
        </button>
        <span className="ba-kind-count">{group.items.length}</span>
        {showProvLed && (
          <span
            className={`ba-kind-prov-led is-${cliProv.tone}`}
            title={provTitle}
            aria-label={`CLI Providers ${cliProv.ok} of ${cliProv.total} ok`}
          >
            <span className="ba-kind-prov-dot" aria-hidden />
            <span className="ba-kind-prov-count">{provDisplay}</span>
          </span>
        )}
        {showWbLed && (
          <span
            className={`ba-kind-wb-led is-${wbTone}`}
            title={wbTitle}
            aria-label={`Workbench panels ${wbMounted} of ${wbTotal} mounted`}
          >
            <span className="ba-kind-wb-dot" aria-hidden />
            <span className="ba-kind-wb-count">{wbDisplay}</span>
          </span>
        )}
        {showAgentLed && (
          <span
            className={`ba-kind-agent-led is-${agentSnap.tone}`}
            title={agentTitle}
            aria-label={`Agent — ${agentSnap.registered} plugin${agentSnap.registered === 1 ? '' : 's'} registered`}
          >
            <span className="ba-kind-agent-dot" aria-hidden />
            <span className="ba-kind-agent-count">{agentDisplay}</span>
          </span>
        )}
        {showMbLed && (
          <span
            className={`ba-kind-mb-led is-${mbSnap.tone}`}
            title={mbTitle}
            aria-label={`Model Binding — ${mbSnap.live} of ${mbSnap.registered} bindings live`}
          >
            <span className="ba-kind-mb-dot" aria-hidden />
            <span className="ba-kind-mb-count">{mbDisplay}</span>
          </span>
        )}
        {showSkillLed && (
          <span
            className={`ba-kind-skill-led is-${skillSnap.tone}`}
            title={skillTitle}
            aria-label={`Skill — ${skillSnap.ready} of ${skillSnap.registered} ready, ${skillSnap.experimental} experimental`}
          >
            <span className="ba-kind-skill-dot" aria-hidden />
            <span className="ba-kind-skill-count">{skillDisplay}</span>
          </span>
        )}
        {showToolLed && (
          <span
            className={`ba-kind-tool-led is-${toolSnap.tone}`}
            title={toolTitle}
            aria-label={`Tool — ${toolSnap.ready} of ${toolSnap.registered} ready, ${toolSnap.exposedAi} AI-exposed, ${toolSnap.experimental} experimental`}
          >
            <span className="ba-kind-tool-dot" aria-hidden />
            <span className="ba-kind-tool-count">{toolDisplay}</span>
          </span>
        )}
        <span className="ba-kind-desc">{kindDescription(group.kind, t)}</span>
      </header>
      {group.kind === 'cli-provider' && <CliCapabilityMatrix items={group.items} />}
      <table className="ba-table">
        <thead>
          <tr>
            <th className="c-chev" aria-label={t('bus.expand')} />
            <th className="c-id">id</th>
            <th className="c-name">displayName.zh</th>
            <th className="c-ver">
              version
              <span
                className="ba-th-sub"
                title={t('bus.versionThSub')}
                aria-hidden
              >
                0.0.x · placeholder ↔ 0.1+ · <em>bumped</em>
              </span>
            </th>
            <th className="c-wb">workbench</th>
            <th className="c-flags">flags</th>
          </tr>
        </thead>
        <tbody>
          {group.items.map((p) => (
            <PluginRow
              key={p.id}
              p={p}
              expanded={expandedIds.has(p.id)}
              onToggle={onToggle}
              rowRefs={rowRefs}
              focused={focusedRowId === p.id}
              onSetFocusedRowId={onSetFocusedRowId}
              onMoveRowFocus={onMoveRowFocus}
              onSoloKind={onSoloKind}
            />
          ))}
        </tbody>
      </table>
    </section>
  );
}

interface PluginRowProps {
  p: BusPluginInfo;
  expanded: boolean;
  onToggle: (id: string) => void;
  rowRefs: React.MutableRefObject<Map<string, HTMLTableRowElement>>;
  focused: boolean;
  onSetFocusedRowId: (id: string) => void;
  onMoveRowFocus: (currentId: string, key: string) => void;
  onSoloKind: (kind: string) => void;
}

function PluginRow({
  p,
  expanded,
  onToggle,
  rowRefs,
  focused,
  onSetFocusedRowId,
  onMoveRowFocus,
  onSoloKind,
}: PluginRowProps) {
  const { t } = useTranslation();
  // Agent 行用统一命名「中文职能·英文名」；其它插件仍用 displayName。
  const nameZh = p.naming?.title || pickLang(p.displayName, 'zh', p.id);
  const descZh = pickLang(p.description, 'zh', '');
  const descEn = pickLang(p.description, 'en', '');
  const wb = p.workbench;
  // P4.63 — lift the P4.62 cell-level verBumped derivation to row scope so the
  // bumped purple language can be expressed at row depth too (whole-row tint +
  // left frame edge), giving Workbench tile-frame parity inside Bus admin.
  const ver = p.version ?? '0.0.0';
  const verBumped = !/^0\.0\./.test(ver);
  const handleClick = () => {
    // P3.58 — mouse click syncs the keyboard focus head so Tab-back into the
    // table later lands on the row the player last interacted with.
    onSetFocusedRowId(p.id);
    onToggle(p.id);
  };
  const rowClass = [
    p.experimental ? 'is-experimental' : '',
    expanded ? 'is-expanded' : '',
    verBumped ? 'is-bumped' : '',
    'is-clickable',
  ]
    .filter(Boolean)
    .join(' ');
  const setRowRef = (el: HTMLTableRowElement | null) => {
    if (el) rowRefs.current.set(p.id, el);
    else rowRefs.current.delete(p.id);
  };
  return (
    <>
      <tr
        ref={setRowRef}
        className={rowClass}
        onClick={handleClick}
        role="button"
        aria-expanded={expanded}
        tabIndex={focused ? 0 : -1}
        onKeyDown={(e) => {
          if (
            e.key === 'ArrowUp' ||
            e.key === 'ArrowDown' ||
            e.key === 'ArrowLeft' ||
            e.key === 'ArrowRight' ||
            e.key === 'Home' ||
            e.key === 'End'
          ) {
            e.preventDefault();
            onMoveRowFocus(p.id, e.key);
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle(p.id);
          }
        }}
        title={expanded ? t('bus.rowTitleCollapse') : t('bus.rowTitleExpand')}
      >
        <td className="c-chev">
          <span className={`ba-chev ${expanded ? 'is-open' : ''}`} aria-hidden>
            {expanded ? '▾' : '▸'}
          </span>
        </td>
        <td className="c-id">
          <code>{p.id}</code>
        </td>
        <td className="c-name">
          <div className="ba-name-zh">{nameZh}</div>
          {descZh && (
            <div className="ba-desc-zh" title={descZh}>
              {descZh}
            </div>
          )}
        </td>
        <td className="c-ver">
          {verBumped ? (
            <span
              className="ba-ver-pill bumped"
              title={t('bus.verBumpedTitle', { ver })}
              aria-label={`${ver} bumped`}
            >
              {ver}
            </span>
          ) : (
            <span className="ba-ver-pill">{ver}</span>
          )}
        </td>
        <td className="c-wb">
          {wb ? (
            <div className="ba-wb-info">
              <span className="ba-wb-icon">{wb.icon ?? '·'}</span>
              <span className="ba-wb-id">{wb.id}</span>
              {wb.panelSize && <span className="ba-wb-pill">{wb.panelSize}</span>}
              {typeof wb.position === 'number' && (
                <span className="ba-wb-pill">pos {wb.position}</span>
              )}
              {wb.hidden && <span className="ba-wb-pill warn">hidden</span>}
            </div>
          ) : (
            <span className="ba-dim">—</span>
          )}
        </td>
        <td className="c-flags">
          {p.experimental && <span className="ba-flag-pill exp">experimental</span>}
        </td>
      </tr>
      {expanded && (
        <tr className="ba-detail-row">
          <td colSpan={6}>
            <PluginDetail p={p} descZh={descZh} descEn={descEn} onSoloKind={onSoloKind} />
          </td>
        </tr>
      )}
    </>
  );
}

function PluginDetail({
  p,
  descZh,
  descEn,
  onSoloKind,
}: {
  p: BusPluginInfo;
  descZh: string;
  descEn: string;
  onSoloKind: (kind: string) => void;
}) {
  const { t } = useTranslation();
  const wb = p.workbench;
  // P3.33 — reverse deep-link wiring. kind=agent rows offer "← 在 Sidebar 高亮"
  // (sets store.pendingSidebarFocusPluginId → AgentsPanel scrolls + flashes the
  // matching card). kind=workbench rows offer "← 打开 wb-* tab" (setMode
  // 'workbench' + setWorkbenchTab(wb.id) so MainArea opens the placeholder).
  // Together with P3.32's forward AgentsPanel pill + P2.7f's wb-tab "在 Bus
  // 详情查看 →" button, this completes the Sidebar ⇄ Bus admin round-trip.
  const openWorkbench = useAppStore((s) => s.openWorkbench);
  const setPendingSidebarFocusPluginId = useAppStore((s) => s.setPendingSidebarFocusPluginId);
  // P3.43 — reuse the P3.38 pendingSidebarKindFlash pipeline (BusAdmin filter-chip
  // click → Sidebar BUS KINDS chip pulse) from inside the detail row, so kinds
  // that lack a kind-specific backlink (cli-provider / model-binding / skill /
  // tool / event) still get a reverse deep-link surface. Brings deep-link
  // coverage from 4/6 kinds (P3.42) to 6/6.
  const setPendingSidebarKindFlash = useAppStore((s) => s.setPendingSidebarKindFlash);
  const onBackToSidebar = () => {
    setPendingSidebarFocusPluginId(p.id);
    // Stay on the bus tab — Sidebar is always visible. Player sees flash in
    // the Sidebar without losing the BusAdminPanel context they came from.
  };
  const onOpenWbTab = () => {
    if (!wb) return;
    // Sidebar entries key as `wb:<workbench.id>` (see Sidebar.tsx busEntries),
    // not the raw wb.id, so we must prefix to match. No center expand → the
    // sidebar opens the plugin's placeholder/left pane.
    openWorkbench({ tab: `wb:${wb.id}`, expandedPluginId: null });
  };
  const onFlashKindFooter = () => {
    setPendingSidebarKindFlash(p.kind);
    // Stay on bus tab — Sidebar BUS KINDS footer is always rendered, so the
    // 1.5s pulse is visible in the player's peripheral vision (left edge).
  };
  const hasAgentLink = p.kind === 'agent';
  const hasWbLink = p.kind === 'workbench' && !!wb;
  const hasKindLink = !hasAgentLink && !hasWbLink;
  // The id IS the npm package; daemon scans packages/marketplace/plugins/<dir>
  // where dir is the trailing segment after the @forgeax-plugin/ scope.
  const dir = p.id.startsWith('@forgeax-plugin/')
    ? p.id.slice('@forgeax-plugin/'.length)
    : p.id;
  const manifestHint = `packages/marketplace/plugins/${dir}/manifest.json`;
  // P4.95 — manifest hint pill becomes click-to-copy. Parallel move to P4.94
  // (entry.frontend lime pill → deep-link button): the cyan manifest path was
  // information-only for 4 weeks; now one click copies it to the clipboard so
  // the player can paste it into a terminal / editor without retyping. A
  // transient "✓ 已复制" hint span fades in for ~1.4s right after click as
  // tactile confirmation, then fades back to invisible (display:none would
  // jolt the grid; opacity transition keeps the cell layout stable).
  const [copiedAt, setCopiedAt] = useState<number | null>(null);
  // P4.97 — version cell joins manifest as click-to-copy. Separate state slot
  // so the manifest copy flash and the version copy flash don't accidentally
  // sympathy-trigger each other when player clicks both in quick succession;
  // each cell has its own ✓ 已复制 hint.
  const [versionCopiedAt, setVersionCopiedAt] = useState<number | null>(null);
  const copyToClipboard = (text: string, onDone: () => void) => {
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(onDone).catch(onDone);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch {}
        document.body.removeChild(ta);
        onDone();
      }
    } catch {
      onDone();
    }
  };
  const onCopyManifest = (e: React.MouseEvent) => {
    e.stopPropagation();
    copyToClipboard(manifestHint, () => {
      setCopiedAt(Date.now());
      window.setTimeout(() => {
        setCopiedAt((prev) => (prev && Date.now() - prev >= 1400 ? null : prev));
      }, 1400);
    });
  };
  const onCopyVersion = (e: React.MouseEvent) => {
    e.stopPropagation();
    copyToClipboard(p.version ?? '0.0.0', () => {
      setVersionCopiedAt(Date.now());
      window.setTimeout(() => {
        setVersionCopiedAt((prev) => (prev && Date.now() - prev >= 1400 ? null : prev));
      }, 1400);
    });
  };
  const copyFlashOn = copiedAt !== null;
  const versionCopyFlashOn = versionCopiedAt !== null;
  return (
    <div className="ba-detail">
      {descZh && (
        <div className="ba-detail-block">
          <div className="ba-detail-label">description.zh</div>
          <div className="ba-detail-body">{descZh}</div>
        </div>
      )}
      {descEn && (
        <div className="ba-detail-block">
          <div className="ba-detail-label">description.en</div>
          <div className="ba-detail-body ba-detail-en">{descEn}</div>
        </div>
      )}
      <div className="ba-detail-grid">
        <div className="ba-detail-cell">
          <div className="ba-detail-label">
            manifest
            <span
              className={`ba-detail-copy-flash${copyFlashOn ? ' on' : ''}`}
              aria-live="polite"
            >
              ✓ {t('bus.copied')}
            </span>
          </div>
          <button
            type="button"
            className={`ba-detail-code ba-detail-manifest-link${copyFlashOn ? ' copied' : ''}`}
            onClick={onCopyManifest}
            title={copyFlashOn ? t('bus.manifestCopiedTitle') : t('bus.manifestCopyTitle')}
          >
            {manifestHint}
          </button>
        </div>
        <div className="ba-detail-cell">
          <div className="ba-detail-label">kind</div>
          {/* P4.96 — detail-row kind tag goes from static <span> to clickable
           * <button>. Click solos the BusAdminPanel filter on this kind via
           * onSoloKind → setEnabledKinds(new Set([kind])), so the player can
           * dive into one plugin's detail and from the same view collapse the
           * panel down to just that kind without scrolling back up to the top
           * filter row. Visual language reuses the existing
           * `button.ba-kind-tag.is-link` hover/focus chrome from the section
           * header kind tag (P3.43) — same component family, two different
           * actions: section-header click flashes the Sidebar BUS KINDS chip,
           * detail-cell click filters the panel itself.
           */}
          <button
            type="button"
            className={`ba-kind-tag k-${p.kind} is-link ba-detail-kind-link`}
            onClick={(e) => {
              e.stopPropagation();
              onSoloKind(p.kind);
            }}
            title={t('bus.detailKindSoloTitle', { kind: p.kind })}
            aria-label={`solo filter kind ${p.kind}`}
          >
            {p.kind}
          </button>
        </div>
        <div className="ba-detail-cell">
          {/* P4.97 — version cell completes detail-grid 4/4 actionable收口: was the
           * lone static <code>. Becomes click-to-copy so player can paste 0.1.0 into
           * a changelog / shell / commit without retyping. Stays in cyan family
           * (mirrors manifest-link's cyan→lime flash semantic from P4.95) so the
           * grid reads as a coherent "copy stack" alongside the lime kind/entry
           * action stack. */}
          <div className="ba-detail-label">
            version
            <span
              className={`ba-detail-copy-flash${versionCopyFlashOn ? ' on' : ''}`}
              aria-live="polite"
            >
              ✓ {t('bus.copied')}
            </span>
          </div>
          <button
            type="button"
            className={`ba-detail-code ba-detail-version-link${versionCopyFlashOn ? ' copied' : ''}`}
            onClick={onCopyVersion}
            title={versionCopyFlashOn ? t('bus.versionCopiedTitle') : t('bus.versionCopyTitle')}
          >
            {p.version}
          </button>
        </div>
        {p.entry?.frontend && (
          <div className="ba-detail-cell">
            <div
              className="ba-detail-label"
              title={t('bus.uiFrontendTitle')}
            >
              ui (frontend)
            </div>
            {/* P4.94 — when the row is a workbench plugin (wb present), upgrade
             * the lime entry.frontend pill from read-only <code> to a clickable
             * deep-link <button> that reuses onOpenWbTab. This closes the loop
             * opened in P4.93: instead of just showing the player WHERE the
             * panel source lives, one click now actually navigates into the
             * Workbench mode + opens that wb-* tab to see the panel rendered.
             * Falls back to <code> for any non-workbench plugin that ever ends
             * up exposing entry.frontend (slim policy strips them today, but
             * the policy could relax). */}
            {wb ? (
              <button
                type="button"
                className="ba-detail-code ba-detail-entry ba-detail-entry-link"
                onClick={(e) => { e.stopPropagation(); onOpenWbTab(); }}
                title={t('bus.entryOpenWbTitle', { wbId: wb.id, path: `packages/marketplace/plugins/${dir}/${p.entry.frontend.replace(/^\.\//, '')}` })}
              >
                {p.entry.frontend}
              </button>
            ) : (
              <code
                className="ba-detail-code ba-detail-entry"
                title={`packages/marketplace/plugins/${dir}/${p.entry.frontend.replace(/^\.\//, '')}`}
              >
                {p.entry.frontend}
              </code>
            )}
          </div>
        )}
        {wb && (
          <div className="ba-detail-cell ba-detail-cell-wide">
            <div className="ba-detail-label">workbench manifest</div>
            <div className="ba-wb-info">
              <span className="ba-wb-icon">{wb.icon ?? '·'}</span>
              <code className="ba-detail-code">{wb.id}</code>
              {wb.panelSize && (
                <span className="ba-wb-pill">panelSize={wb.panelSize}</span>
              )}
              {typeof wb.position === 'number' && (
                <span className="ba-wb-pill">position={wb.position}</span>
              )}
              {wb.hidden && <span className="ba-wb-pill warn">hidden</span>}
            </div>
          </div>
        )}
      </div>
      <ProvidesDetail p={p} />
      <div className="ba-backlinks">
        {hasAgentLink && (
          <button
            type="button"
            className="ba-backlink ba-backlink-agent"
            onClick={onBackToSidebar}
            title={t('bus.backlinkAgentTitle', { id: p.id })}
          >
            ← {t('bus.backlinkAgent')}
          </button>
        )}
        {hasWbLink && (
          <button
            type="button"
            className="ba-backlink ba-backlink-wb"
            onClick={onOpenWbTab}
            title={t('bus.backlinkWbTitle', { wbId: wb!.id })}
          >
            ← {t('bus.backlinkWb')}
          </button>
        )}
        {hasKindLink && (
          <button
            type="button"
            className={`ba-backlink ba-backlink-kind k-${p.kind}`}
            onClick={onFlashKindFooter}
            title={t('bus.backlinkKindTitle', { kind: p.kind })}
          >
            <span className="ba-backlink-kind-dot" aria-hidden>●</span>
            ← {t('bus.backlinkKind')} · {p.kind}
          </button>
        )}
      </div>
      <div className="ba-detail-note">
        {t('bus.detailNoteBroken')}
      </div>
    </div>
  );
}

// P2.6g — render the slim provides.{skills,tools,events,cliProvider} subsets
// the server projects (file paths + runner cmd/args + httpAdapter.auth all
// stripped). Returns null when the plugin advertises none of these — keeps
// the detail row visually identical for plugins where only workbench /
// modelBinding apply (those have their own dedicated cells / strips upstream).
function ProvidesDetail({ p }: { p: BusPluginInfo }) {
  const { t } = useTranslation();
  const cp = p.cliProvider;
  const skills = p.skills ?? [];
  const tools = p.tools ?? [];
  const events = p.events ?? [];
  const cliCount = cp ? 1 : 0;
  const tally: Array<{
    kind: 'cli-provider' | 'skill' | 'tool' | 'event';
    label: string;
    count: number;
    aiTitle: string;
  }> = [
    { kind: 'cli-provider', label: 'cli', count: cliCount, aiTitle: t('bus.tallyCliTitle') },
    { kind: 'skill', label: 'skill', count: skills.length, aiTitle: t('bus.tallySkillTitle') },
    { kind: 'tool', label: 'tool', count: tools.length, aiTitle: t('bus.tallyToolTitle') },
    { kind: 'event', label: 'event', count: events.length, aiTitle: t('bus.tallyEventTitle') },
  ];
  const totalProvides = cliCount + skills.length + tools.length + events.length;
  return (
    <div className="ba-provides">
      <div className="ba-provides-label">provides</div>
      <div className="ba-provides-body">
        <div
          className={`ba-prov-tally${totalProvides === 0 ? ' empty' : ''}`}
          title={totalProvides === 0
            ? t('bus.provTallyEmptyTitle')
            : t('bus.provTallyTitle', { n: totalProvides })}
        >
          {tally.map((t) => (
            <span
              key={t.kind}
              className={`ba-prov-tally-pill k-${t.kind}${t.count === 0 ? ' dim' : ''}`}
              title={t.aiTitle}
            >
              <span className="ba-prov-tally-label">{t.label}</span>
              <b className="ba-prov-tally-count">{t.count}</b>
            </span>
          ))}
          {totalProvides === 0 && (
            <span className="ba-prov-tally-note">{t('bus.provTallyNote')}</span>
          )}
        </div>
        {cp && (
          <div className="ba-prov-block ba-prov-cli">
            <div className="ba-prov-head">
              <span className="ba-prov-tag k-cli-provider">cliProvider</span>
              <code className="ba-prov-id">{cp.id}</code>
              <span className="ba-prov-display">{cp.displayName}</span>
            </div>
            {cp.models && cp.models.length > 0 && (
              <div className="ba-prov-row">
                <span className="ba-prov-rowlabel">models</span>
                <div className="ba-prov-pills">
                  {cp.models.map((m) => (
                    <code key={m} className="ba-prov-pill ba-prov-model">{m}</code>
                  ))}
                </div>
              </div>
            )}
            <div className="ba-prov-row">
              <span className="ba-prov-rowlabel">capabilities</span>
              <div className="ba-prov-pills">
                {capabilityChips(cp.capabilities)}
              </div>
            </div>
          </div>
        )}
        {skills.length > 0 && (
          <div className="ba-prov-block ba-prov-skills">
            <div className="ba-prov-head">
              <span className="ba-prov-tag k-skill">skills</span>
              <span className="ba-prov-count">{skills.length}</span>
            </div>
            <ul className="ba-prov-list">
              {skills.map((s) => (
                <li key={s.id}>
                  <code className="ba-prov-pill ba-prov-skill-id">{s.id}</code>
                  <span className="ba-prov-sep">·</span>
                  <code className="ba-prov-pill ba-prov-trigger">{s.trigger}</code>
                </li>
              ))}
            </ul>
          </div>
        )}
        {tools.length > 0 && (
          <div className="ba-prov-block ba-prov-tools">
            <div className="ba-prov-head">
              <span className="ba-prov-tag k-tool">tools</span>
              <span className="ba-prov-count">{tools.length}</span>
            </div>
            <ul className="ba-prov-list">
              {tools.map((tool) => (
                <li key={tool.id}>
                  <code className="ba-prov-pill ba-prov-tool-id">{tool.id}</code>
                  {tool.exposedToAI && (
                    <span className="ba-prov-flag" title={t('bus.provAiFlagTitle')}>
                      AI
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {events.length > 0 && (
          <div className="ba-prov-block ba-prov-events">
            <div className="ba-prov-head">
              <span className="ba-prov-tag k-event">events</span>
              <span className="ba-prov-count">{events.length}</span>
            </div>
            <ul className="ba-prov-list">
              {events.map((e) => (
                <li key={e.name}>
                  <code className="ba-prov-pill ba-prov-event-name">{e.name}</code>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function capabilityChips(caps: NonNullable<BusPluginInfo['cliProvider']>['capabilities']) {
  // 5 fixed keys per CliProviderCapability.capabilities in
  // packages/server/src/bus/types/registry.ts — pre-rendered in a stable order
  // so the player can compare two cli-providers row-by-row.
  const order: Array<keyof typeof caps> = [
    'streaming',
    'thinking',
    'toolCalls',
    'subAgents',
    'sessions',
  ];
  return order.map((k) => (
    <span
      key={k}
      className={`ba-prov-cap ${caps[k] ? 'is-on' : 'is-off'}`}
      title={caps[k] ? `${k}=true` : `${k}=false`}
    >
      <span className="ba-prov-cap-dot" aria-hidden>{caps[k] ? '●' : '○'}</span>
      {k}
    </span>
  ));
}

// P3.21 — 5 capability keys, stable order matches the order in ProvidesDetail
// `capabilityChips()` above so a player who learns the column order in either
// surface reads the other at a glance. Short labels keep the compact matrix
// dense (each cell ~26px tall) — full title in tooltip.
const CLI_CAP_KEYS = ['streaming', 'thinking', 'toolCalls', 'subAgents', 'sessions'] as const;
const CLI_CAP_SHORT: Record<(typeof CLI_CAP_KEYS)[number], string> = {
  streaming: 'stream',
  thinking: 'think',
  toolCalls: 'tools',
  subAgents: 'sub-ag',
  sessions: 'sess',
};

function CliCapabilityMatrix({ items }: { items: BusPluginInfo[] }) {
  // Defensive: only rows that actually expose cliProvider make it into the
  // matrix. Server never emits cli-provider kind without cliProvider, but the
  // filter keeps the matrix correct if that ever drifts.
  const rows = items.filter((p) => !!p.cliProvider);
  if (rows.length === 0) return null;
  const colTotals = CLI_CAP_KEYS.map(
    (k) => rows.filter((r) => r.cliProvider!.capabilities[k]).length,
  );
  const totalCells = rows.length * CLI_CAP_KEYS.length;
  const onCells = colTotals.reduce((a, b) => a + b, 0);
  const fullCoverage = onCells === totalCells;
  const coveragePct = totalCells === 0 ? 0 : Math.round((onCells / totalCells) * 100);
  return (
    <div className="ba-cli-matrix">
      <div className="ba-cli-matrix-head">
        <span className="ba-cli-matrix-label">capability matrix</span>
        <span className="ba-cli-matrix-meta">
          {rows.length} cli · {CLI_CAP_KEYS.length} cap
        </span>
      </div>
      <table className="ba-cli-matrix-table">
        <thead>
          <tr>
            <th className="ba-cli-matrix-corner" aria-label="cli provider name" />
            {CLI_CAP_KEYS.map((k, i) => {
              const total = colTotals[i];
              const full = total === rows.length;
              return (
                <th key={k} className="ba-cli-matrix-th" title={k}>
                  <span className="ba-cli-matrix-th-name">{CLI_CAP_SHORT[k]}</span>
                  <span
                    className={`ba-cli-matrix-coverage ${full ? 'is-full' : 'is-partial'}`}
                    title={`${total} / ${rows.length} cli support ${k}`}
                  >
                    {total}/{rows.length}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const cp = p.cliProvider!;
            const dn = pickLang(p.displayName, 'zh', cp.displayName);
            return (
              <tr key={p.id}>
                <td className="ba-cli-matrix-rowname">
                  <span className="ba-cli-matrix-rowname-zh">{dn}</span>
                  <code className="ba-cli-matrix-rowname-id" title={p.id}>{shortCliId(p.id)}</code>
                </td>
                {CLI_CAP_KEYS.map((k) => {
                  const on = cp.capabilities[k];
                  return (
                    <td
                      key={k}
                      className={`ba-cli-matrix-cell ${on ? 'is-on' : 'is-off'}`}
                      title={`${dn} · ${k} = ${on}`}
                    >
                      <span className="ba-cli-matrix-dot" aria-hidden>
                        {on ? '●' : '○'}
                      </span>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div
        className={`ba-cli-matrix-summary ${fullCoverage ? 'is-full' : 'is-partial'}`}
        title={`${onCells} of ${totalCells} capability cells active`}
      >
        <span className="ba-cli-matrix-summary-dot" aria-hidden>
          {fullCoverage ? '●' : '◐'}
        </span>
        <span className="ba-cli-matrix-summary-text">
          {fullCoverage
            ? `${rows.length} cli × ${CLI_CAP_KEYS.length} cap · 100% coverage`
            : `${onCells} / ${totalCells} cap on · ${coveragePct}% coverage`}
        </span>
      </div>
    </div>
  );
}

// Strip @forgeax-plugin/cli- prefix so row labels stay narrow (one of
// "claude-code" / "codex" / "cursor-agent" / "forgeax") and the dense matrix
// can fit on a typical viewport without truncation.
function shortCliId(id: string): string {
  return id.replace(/^@forgeax-plugin\/cli-/, '').replace(/^@forgeax-plugin\//, '');
}

function kindDescription(kind: string, t: TFunction): string {
  switch (kind) {
    case 'workbench':
      return t('bus.kindDescWorkbench');
    case 'agent':
      return t('bus.kindDescAgent');
    case 'cli-provider':
      return t('bus.kindDescCliProvider');
    case 'model-binding':
      return t('bus.kindDescModelBinding');
    case 'skill':
      return t('bus.kindDescSkill');
    case 'tool':
      return t('bus.kindDescTool');
    default:
      return t('bus.kindDescUnknown');
  }
}
