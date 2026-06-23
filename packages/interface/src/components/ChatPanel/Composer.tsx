import { useState, useRef, useEffect, useMemo } from 'react';


import { AtSign, SquareChartGantt, Upload, ChevronDown, ArrowUp, Unplug, Square, Zap, Pencil, Trash2 } from 'lucide-react';
import { useAppStore } from '../../store';
import { useModelLabel } from '../../lib/model';
import { listBusPlugins, pickLang, type BusPluginInfo } from '../../lib/bus-api';
import { RichInput, type RichInputHandle } from '../Composer/RichInput';
import {
  getAgentModel,
  type AgentModelState,
} from '../../lib/model-config';
import { ModelPicker } from '../ModelPicker';
import ContextRing from './ContextRing';
import { usePendingPermission } from '../../lib/permission-stream';
interface CliProviderInfo {
  id: string;
  displayName: string;
  health: { ok: boolean; detail?: string };
}

// 2026-05-20 — `cb-mbsel`（模型选择按钮）从「kind=model-binding 插件预览 +
// BusAdmin deep-link」改造成真正的模型选择器：label 来自当前 agent.json::models.model
// 的 selected（用 commands.get_agent_model 读盘），下拉列出 `~/.forgeax/key/models.json`
// 的全量 catalog（用 commands.list_models 拿）；点击切换走 commands.set_agent_models
// 真实写回 agent.json，server 端自动 controlAgent("restart") 让已 running 的 agent
// 重读盘。2026-06-02 起 claude-code 桥也消费 agent.json::models.model（chat 桥把它
// 解析进 req.options.model，provider 转成 `claude --model <id>`），所以 forgeax 与
// claude-code 渠道都允许切换（见 canSwitchModel）；其余尚未接线的第三方 cli-provider
// （codex/cursor…）仍 disabled —— 对它们改 agent.json 不生效。
//
// 2026-05-17 — ComposerToolRow + .cb-tl-strip 删除。tool 插件入口由 Bus
// admin 承载,Composer 上方常驻一条 orange chip 是冗余。

// P3.45 — flattened row for the Sparkles ("/") menu. Each bus skill plugin
// can declare multiple skills[], so a single plugin may yield multiple rows.
// Until P3.45 the Sparkles button was a permanent 即将上线 placeholder; now
// it surfaces real bus skill triggers and lets the player insert them at the
// textarea cursor without typing the full slash path.
interface BusSkillRow {
  pluginId: string;
  displayName: string;
  descZh: string;
  skillId: string;
  trigger: string;
}

// P3.46 — agent mention row for the @ menu. Mirrors the P3.45 Sparkles popover
// pattern but pulls agents (marketplace + bus, deduped by id) so the player
// can drop `@agent ` tokens into the prompt without remembering exact ids.
// The @ button was the 2nd remaining 即将上线 placeholder in composer-bar;
// this turns it into a working insertion source.
interface AgentMentionRow {
  id: string;
  name: string;
  role: string;
  avatar: string;
  isMain: boolean;
  inBus: boolean;
  // P3.48 — bus plugin id (e.g. `@forgeax-plugin/agent-cc-coder`) when inBus,
  // enabling per-row Bus admin deep-link via pendingBusExpandId pipeline.
  busPluginId?: string;
}

// P2.7d — bus cli-provider ids follow `@forgeax-plugin/cli-{providerId}` (see
// packages/marketplace/plugins/cli-*/forgeax-plugin.json). Strip the prefix so
// we can cross-reference with the runtime /api/cli-providers id list.
const BUS_CLI_ID_PREFIX = '@forgeax-plugin/cli-';

// P2.7g — entry in the bus cli-provider map. Holds enough of the plugin
// manifest to render a description mini-strip under each dropdown row. We
// keep the full BusPluginInfo so future extensions (manifest version /
// experimental flag etc.) don't need another refetch.
interface BusCliEntry {
  full: BusPluginInfo;
  descZh: string;
}

// Hard-coded fallback display names so a persisted providerOverride doesn't
// flash its bare id ("claude-code") for one frame after reload before
// /api/cli-providers populates the real list. Keep keys in sync with the
// known provider ids in server/src/cli-providers/.
const PROVIDER_DISPLAY_FALLBACK: Record<string, string> = {
  'forgeax': 'ForgeaX CLI',
  'claude-code': 'the reference agent CLI',
  'codex': 'OpenAI Codex',
  'cursor-agent': 'Cursor',
};

// iter-107: enumerate the placeholder-button hint ids. Centralizes the
// strings so typos become compile errors instead of silently breaking the
// `hintFor === 'at'` checks, and makes "where can a future button slot in"
// obvious. Keep these short — they only flow through component-local state.
const CB_HINT = { AT: 'at', SLASH: 'slash', IMG: 'img' } as const;
type CbHintId = typeof CB_HINT[keyof typeof CB_HINT];

function compactModelLabel(label: string): string {
  const trimmed = label.trim();
  const slugOpus = trimmed.match(/claude[-_\s]+opus[-_\s]+([\d.]+)(?:[-_\s]+(\d))?/i);
  if (slugOpus) return `Opus ${slugOpus[1]}${slugOpus[2] ? `.${slugOpus[2]}` : ''}`;
  return trimmed
    .replace(/^claude[-_\s]+/i, '')
    .replace(/\bclaude\b\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactProviderLabel(label: string, providerId: string | null): string {
  if (!providerId || providerId === 'forgeax' || /^forgeax\b/i.test(label)) return 'FX';
  if (/claude/i.test(label) || /claude/i.test(providerId)) return 'Claude';
  if (/codex|openai/i.test(label) || /codex|openai/i.test(providerId)) return 'Codex';
  if (/cursor/i.test(label) || /cursor/i.test(providerId)) return 'Cursor';
  return label.replace(/\b(code|cli|agent)\b/gi, '').trim() || providerId;
}

export function Composer() {
  const [text, setText] = useState('');
  const sendMessage = useAppStore((s) => s.sendMessage);
  const cancelStream = useAppStore((s) => s.cancelStream);
  const isStreaming = useAppStore((s) => s.isStreaming);
  // Message queue (Cursor-style): while streaming, sends land here and flush
  // one-per-turn on hook:turnEnd. Keyed by `${sid}::${agentId}` in the store.
  const enqueueMessage = useAppStore((s) => s.enqueueMessage);
  const dequeueMessage = useAppStore((s) => s.dequeueMessage);
  const clearQueue = useAppStore((s) => s.clearQueue);
  const queuedMessages = useAppStore((s) => s.queuedMessages);
  const providerOverride = useAppStore((s) => s.providerOverride);
  const setProviderOverride = useAppStore((s) => s.setProviderOverride);
  // Derive from active tab's agent binding (first-class key, post-PR #9).
  // null when the active tab hasn't been pinned yet (fresh tab pre-
  // AgentSwitcher fetch).
  const activeAgent = useAppStore(
    (s) => s.tabs.find((t) => t.sid === s.activeSid)?.agentId ?? null,
  );
  const activeSid = useAppStore((s) => s.activeSid);
  // P8 — while a claude-code permission card is up the turn is *blocked waiting
  // on the user*, not idle. Sending now would cancel that turn (SIGTERM →
  // `claude exited 143`) yet leave the card answering a dead turn. So we gate
  // send/queue/interrupt on "no pending permission for this session" and nudge
  // the user to resolve the card first. Stop (cancelStream) stays available.
  const pendingPermission = usePendingPermission(activeSid);
  const [permFlash, setPermFlash] = useState(false);
  useEffect(() => {
    if (!permFlash) return;
    const id = setTimeout(() => setPermFlash(false), 2600);
    return () => clearTimeout(id);
  }, [permFlash]);
  // Card resolved → drop any stale "处理授权" nudge.
  useEffect(() => {
    if (!pendingPermission) setPermFlash(false);
  }, [pendingPermission]);
  // P3.36 deep-link slot — cli dropdown row's bus pill into Bus admin.
  // Reuses the pendingBusExpandId pipeline (P2.7f Sidebar / P3.32 AgentsPanel /
  // P3.34 ChatPanel agent bar). Set BEFORE switching mode so BusAdminPanel's
  // mount-time consumer reads non-null on first render.
  const setMode = useAppStore((s) => s.setMode);
  const openSettings = useAppStore((s) => s.openSettings);
  const setPendingBusExpandId = useAppStore((s) => s.setPendingBusExpandId);
  // 2026-05-20 — cb-mbsel deep-link 到 BusAdmin kind=model-binding 的入口
  // 删除（mb popover 现在是真模型选择器，不再混 bus 数据源）。setPendingBusKindFilter
  // 还在 store 上，未来如果 mbsel 头部要重新加 "在 bus 详情里看 model-binding
  // 插件" 链接，仍可直接复用 —— 不必新增 store slot。
  const modelLabel = useModelLabel();
  const ref = useRef<RichInputHandle>(null);

  // Provider list — fetched once on mount; refetched on every dropdown open
  // so health-pill state stays fresh (codex might just have been installed).
  const [providers, setProviders] = useState<CliProviderInfo[]>([]);
  // P2.7d — map of provider ids that are ALSO exposed by bus as cli-provider
  // plugins. Drives the small "bus" pill on each dropdown row, signalling
  // "this CLI backend is reachable via two surfaces". Refetched on dropdown
  // open in case a new plugin was hot-loaded.
  // P2.7g — upgraded from Set<string> to Map<id, BusCliEntry> so each row can
  // also surface the bus manifest description.zh as a permanent mini-strip
  // (previously the description was hidden inside `title=` hover-tooltip on
  // the bus pill — invisible on a default scan).
  const [busCliMap, setBusCliMap] = useState<Map<string, BusCliEntry>>(new Map());
  // 当前 activeAgent 在 agent.json 里的 model 状态（get_agent_model 读盘）。
  // null = 还没拉到 / 拉失败 / 当前不走 forgeax 渠道（cli 桥不读 agent.json）。
  // ModelPicker 内部自己拉 list_models catalog（useModelCatalog hook,会跨
  // Composer / TopBar / ModelLab 共享 cache）—— 这里只持 agent 当前选择。
  const [agentModel, setAgentModel] = useState<AgentModelState | null>(null);
  // 2026-05-20 重做后 sid 真值住 store.activeSid —— 不再单独本地 state。
  // 旧 ensureForgeaXSid 单例已删，所有需要 sid 的调用直接用 activeSid。
  const forgeaxSid = activeSid;
  // P3.45 — bus skill rows (flattened across all kind=skill plugins). Null
  // until the first fetch resolves so the Sparkles button stays in legacy
  // cb-soon mode until we know there's at least one trigger to offer.
  const [busSkills, setBusSkills] = useState<BusSkillRow[] | null>(null);
  const [slashOpen, setSlashOpen] = useState(false);
  // P3.46 — agent rows merged from /api/workbench/agents `.agents` (marketplace,
  // 7) and `.agents_from_bus` (bus, 1). Null = unfetched / failed → the @ button
  // stays in legacy cb-soon mode. The endpoint already returns both arrays so
  // we don't need a second bus call.
  const [agentMentions, setAgentMentions] = useState<AgentMentionRow[] | null>(null);
  const [atOpen, setAtOpen] = useState(false);
  // P3.49 — keyboard navigation for the slash / at popovers. -1 = no row focused
  // (idle / mouse mode), 0..N-1 = the corresponding popover row. Refs feed the
  // window keydown closure (which only re-registers on *Open toggle) so it can
  // read fresh idx/length without re-binding per keystroke.
  // Note: model-picker keyboard nav lives inside <ModelPicker> itself.
  const [slashFocused, setSlashFocused] = useState(-1);
  const [atFocused, setAtFocused] = useState(-1);
  const slashFocusedRef = useRef(-1);
  const atFocusedRef = useRef(-1);
  const busSkillsRef = useRef<BusSkillRow[] | null>(null);
  const agentMentionsRef = useRef<AgentMentionRow[] | null>(null);
  useEffect(() => { slashFocusedRef.current = slashFocused; }, [slashFocused]);
  useEffect(() => { atFocusedRef.current = atFocused; }, [atFocused]);
  useEffect(() => { busSkillsRef.current = busSkills; }, [busSkills]);
  useEffect(() => { agentMentionsRef.current = agentMentions; }, [agentMentions]);
  const [cliOpen, setCliOpen] = useState(false);
  // Keyboard navigation: -1 means no focused item, 0 = 'forgeax' default row, 1..N = providers list.
  const [cliFocused, setCliFocused] = useState(-1);
  // Refs mirror current cliFocused + providers so the window keydown closure (which
  // attaches once per cliOpen toggle) can read fresh values without re-registering.
  const cliFocusedRef = useRef(-1);
  const providersRef = useRef<CliProviderInfo[]>([]);
  useEffect(() => { cliFocusedRef.current = cliFocused; }, [cliFocused]);
  useEffect(() => { providersRef.current = providers; }, [providers]);
  const fetchProviders = async () => {
    try {
      const { fetchCliProviders } = await import('../../lib/cli-providers');
      const { providers: list } = await fetchCliProviders();
      setProviders(list);
      // Self-heal a stale persisted override: if localStorage points at a
      // provider that the server no longer registers (provider removed,
      // typo'd at write-time, etc.), reset to auto. Without this the user
      // would see an "unknown providerOverride" error on every turn and
      // have to manually fix it via the dropdown.
      const persisted = useAppStore.getState().providerOverride;
      if (persisted && list.length > 0 && !list.some((p) => p.id === persisted)) {
        console.warn(`[composer] cleared stale providerOverride="${persisted}" (not in registered providers: ${list.map((p) => p.id).join(',')})`);
        setProviderOverride(null);
      }
    } catch { /* ignore */ }
  };
  // P2.7d/g — independent of /api/cli-providers. Failure here just hides the
  // bus pill + description mini-strip; the dropdown still works.
  const fetchBusCliInfo = async () => {
    try {
      const resp = await listBusPlugins('cli-provider');
      const next = new Map<string, BusCliEntry>();
      for (const item of resp.items) {
        if (!item.id.startsWith(BUS_CLI_ID_PREFIX)) continue;
        const providerId = item.id.slice(BUS_CLI_ID_PREFIX.length);
        next.set(providerId, {
          full: item,
          descZh: pickLang(item.description, 'zh', ''),
        });
      }
      setBusCliMap(next);
    } catch { /* ignore — pill + strip simply absent */ }
  };
  // 2026-05-20 — 拉 activeAgent 在 agent.json::models.model 里的当前选择。仅在
  // forgeax 渠道（providerOverride === null/'forgeax'）+ 有 activeAgent + 有 sid
  // 时才发请求；第三方 cli 桥不读 agent.json，强行 get 会拿错语义。失败兜底
  // null，UI 用 useModelLabel() 字符串占位。
  const fetchAgentModel = async (sid: string, agentPath: string) => {
    try {
      const m = await getAgentModel(sid, agentPath);
      // race 兜底：fetch 期间 activeAgent / sid 已经切走，不更新 stale 数据。
      const cur = useAppStore.getState();
      const tab = cur.tabs.find((t) => t.sid === cur.activeSid);
      if (tab?.agentId === agentPath && cur.activeSid === sid) {
        setAgentModel(m);
      }
    } catch (err) {
      console.warn('[composer] get_agent_model failed', { sid, agentPath, err });
      setAgentModel(null);
    }
  };
  // P3.45 — fetch all kind=skill plugins, flatten each plugin's skills[] into
  // single rows. Failure / empty → null, which collapses the Sparkles button
  // back to its legacy 即将上线 hint behaviour.
  const fetchBusSkills = async () => {
    try {
      const resp = await listBusPlugins('skill');
      const rows: BusSkillRow[] = [];
      for (const item of resp.items) {
        const skills = item.skills ?? [];
        for (const s of skills) {
          if (!s.trigger) continue;
          rows.push({
            pluginId: item.id,
            displayName: pickLang(item.displayName, 'zh', item.id),
            descZh: pickLang(item.description, 'zh', ''),
            skillId: s.id,
            trigger: s.trigger,
          });
        }
      }
      // Merge server commands (e.g. /compact) into the slash popover alongside bus skills.
      try {
        const cmdResp = await fetch('/api/commands');
        if (cmdResp.ok) {
          const { commands } = (await cmdResp.json()) as { commands?: Array<{ name: string; description: string; hasExecute: boolean }> };
          for (const cmd of commands ?? []) {
            if (!cmd.hasExecute) continue;
            if (cmd.name.startsWith('_error:')) continue;
            rows.push({
              pluginId: 'server',
              displayName: cmd.name,
              descZh: cmd.description,
              skillId: cmd.name,
              trigger: `/${cmd.name}`,
            });
          }
        }
      } catch { /* server commands unavailable — still show bus skills */ }
      setBusSkills(rows);
    } catch { setBusSkills(null); }
  };
  // P3.46 — pull /api/workbench/agents once, merge marketplace + bus by id.
  // Bus agents (`agents_from_bus[]`) currently overlap with marketplace
  // cc-coder, so the merge yields 7 unique rows with cc-coder flagged inBus.
  // Order: marketplace order first (player already sees this order in Sidebar
  // AGENTS list and AgentSwitcher), then bus-only agents appended.
  const fetchAgentMentions = async () => {
    try {
      const res = await fetch('/api/workbench/agents');
      if (!res.ok) throw new Error(`GET /api/workbench/agents → ${res.status}`);
      const data = (await res.json()) as {
        agents?: Array<{ id: string; name: string; role: string; avatar: string; isMain: boolean }>;
        agents_from_bus?: Array<{ id: string; name: string; role: string; avatar: string; pluginId?: string }>;
      };
      const busPluginIds = new Map<string, string>();
      for (const a of data.agents_from_bus ?? []) {
        if (a.pluginId) busPluginIds.set(a.id, a.pluginId);
      }
      const rows: AgentMentionRow[] = [];
      const seen = new Set<string>();
      for (const a of data.agents ?? []) {
        rows.push({
          id: a.id,
          name: a.name,
          role: a.role,
          avatar: a.avatar,
          isMain: !!a.isMain,
          inBus: busPluginIds.has(a.id),
          busPluginId: busPluginIds.get(a.id),
        });
        seen.add(a.id);
      }
      for (const a of data.agents_from_bus ?? []) {
        if (seen.has(a.id)) continue;
        rows.push({
          id: a.id,
          name: a.name,
          role: a.role,
          avatar: a.avatar,
          isMain: false,
          inBus: true,
          busPluginId: a.pluginId,
        });
      }
      setAgentMentions(rows);
    } catch { setAgentMentions(null); }
  };
  useEffect(() => {
    void fetchProviders();
    void fetchBusCliInfo();
    void fetchBusSkills();
    void fetchAgentMentions();
  }, []);
  useEffect(() => {
    if (cliOpen) {
      void fetchProviders();
      void fetchBusCliInfo();
      setCliFocused(-1);  // reset focus when reopening
    }
  }, [cliOpen]);

  // 2026-05-20 — forgeax 渠道 + 有 activeAgent + 有 sid 时拉 agent.json 当前
  // model。任意条件变化都重拉。其余情况清空 agentModel（cb-mbsel 降级用
  // useModelLabel）。
  const isForgeaXNative = providerOverride === null || providerOverride === 'forgeax';
  // 2026-06-02 — claude-code 现在也读 agent.json::models.model（chat 桥把它解析进
  // req.options.model，provider 转成 `claude --model`），所以模型选择器对 claude-code
  // 渠道同样有效，不再 disabled。其余第三方 cli-provider（codex/cursor…）仍按需保守 disabled。
  const canSwitchModel =
    isForgeaXNative || providerOverride === 'claude-code';
  useEffect(() => {
    if (!canSwitchModel || !activeAgent || !forgeaxSid) {
      setAgentModel(null);
      return;
    }
    void fetchAgentModel(forgeaxSid, activeAgent);
  }, [canSwitchModel, activeAgent, forgeaxSid]);

  // Auto-close the dropdown if a stream starts while it's open. The override
  // wouldn't apply to the in-flight turn anyway, so showing a clickable list
  // while the result is already streaming is misleading.
  useEffect(() => {
    if (isStreaming && cliOpen) setCliOpen(false);
  }, [isStreaming, cliOpen]);
  // Close dropdown on outside click or Esc.
  useEffect(() => {
    if (!cliOpen) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest('.cb-cli')) setCliOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setCliOpen(false);
        return;
      }
      // ↑/↓ cycle through items; Enter commits the focused one.
      // Item indices: 0 = 'forgeax' (default row), 1..N = providers[i-1].
      // Read via refs so the closure sees current values (effect re-runs only on cliOpen).
      const list = providersRef.current;
      const total = list.length + 1;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCliFocused((i) => (i + 1 + total) % total);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCliFocused((i) => (i <= 0 ? total - 1 : i - 1));
      } else if (e.key === 'Enter') {
        const focused = cliFocusedRef.current;
        if (focused < 0) return;
        e.preventDefault();
        if (focused === 0) {
          setProviderOverride(null);
          setCliOpen(false);
        } else {
          const p = list[focused - 1];
          // Only commit + close on a healthy pick. Enter on a DOWN row used to
          // silently close the dropdown, which felt like a swallowed keystroke
          // (mouse click on disabled row is already blocked by `disabled=`).
          // Keep the menu open so the user can pick another row instead.
          if (p && p.health.ok) {
            setProviderOverride(p.id);
            setCliOpen(false);
          }
        }
      }
    };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [cliOpen]);
  // R3 (2026-05-20)：默认行（providerOverride === null）的语义从「auto · 用
  // agent 自己 declared 的 backend」变成「forgeax 原生 · 直发 Session/EventBus」。
  // 三方 CLI 桥（claude-code 等）继续作为下面的可选条目。等 commands.attach_script_agent
  // 把 ScriptAgent 接进 Session 之后，下面这些 CLI 行整片下线。
  const currentLabel = providerOverride
    ? providers.find((p) => p.id === providerOverride)?.displayName
        ?? PROVIDER_DISPLAY_FALLBACK[providerOverride]
        ?? providerOverride
    : 'ForgeaX';
  // Detect "override is set but its provider is currently 不可用". The probe
  // row exists (claude-code/codex registered) but health.ok=false. We can't
  // clear the persisted override (user picked it deliberately), but we can
  // warn in the button tooltip + apply a cb-cli-warning class so the user
  // knows turns will error before they hit send.
  const overrideRow = providerOverride
    ? providers.find((p) => p.id === providerOverride)
    : undefined;
  const overrideDown = !!overrideRow && !overrideRow.health.ok;
  const cliButtonTitle = isStreaming
    ? 'Streaming — provider locked for this turn (Esc/Stop to cancel)'
    : overrideDown
      ? `⚠ ${providerOverride} is currently 不可用 — pick 'forgeax' or another healthy provider, or turns will error.`
      : providerOverride
        ? `All turns route via ${providerOverride}. Pick 'forgeax' for the native EventBus path.`
        : "Provider — forgeax (原生 · 消息直发 Session/EventBus)";
  // @ / slash / image icons are placeholders for upcoming features. Title-tooltip
  // alone is hover-only + touch-unfriendly. Same click-hint pattern as iter-55
  // AgentSwitcher: aria-disabled lets clicks reach the handler, a brand-yellow
  // pill flashes "即将上线" for 2s.
  const [hintFor, setHintFor] = useState<CbHintId | null>(null);
  useEffect(() => {
    if (!hintFor) return;
    const id = setTimeout(() => setHintFor(null), 2000);
    return () => clearTimeout(id);
  }, [hintFor]);

  // P3.45 — close slash popover on outside-click or Escape. Mirrors the cliOpen
  // dismissal contract so two popovers in the same composer-bar behave the
  // same way to the player.
  useEffect(() => {
    if (!slashOpen) {
      setSlashFocused(-1);
      return;
    }
    setSlashFocused(0);
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest('.cb-slash')) setSlashOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashOpen(false);
        return;
      }
      const list = filteredSkillsRef.current;
      const total = list.length;
      if (total === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashFocused((i) => (i < 0 ? 0 : (i + 1) % total));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashFocused((i) => (i <= 0 ? total - 1 : i - 1));
      } else if (e.key === 'Enter') {
        const idx = slashFocusedRef.current;
        if (idx < 0 || idx >= total) return;
        e.preventDefault();
        insertSkillTrigger(list[idx].trigger);
      }
    };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [slashOpen]);

  // P3.45 — insert the trigger at the current cursor position (or end if no
  // selection). Appends a trailing space so the user can immediately type
  // arguments without hitting space first. Refocus the textarea + move caret
  // after the inserted text so the inserted trigger feels like a single
  // typed-out token rather than a paste.
  const insertSkillTrigger = (trigger: string) => {
    const insertion = `${trigger} `;
    setSlashOpen(false);
    const r = ref.current;
    // If user was typing a prefix (e.g. "/c"), replace the entire text with the
    // selected trigger + trailing space. Otherwise insert at cursor (button mode).
    if (slashPrefixMatch) {
      if (r) {
        r.setValue(insertion);
        r.focus();
      } else {
        setText(insertion);
      }
    } else {
      if (r) {
        r.focus();
        r.insertText(insertion);
      } else {
        setText((t) => `${t}${insertion}`);
      }
    }
  };

  const slashHasSkills = !!(busSkills && busSkills.length > 0);

  // Text-driven slash popover: auto-open when text is just a command prefix
  // (e.g. "/", "/c", "/compact") and auto-close otherwise.
  const slashPrefixMatch = text.match(/^\/([a-z0-9_-]*)$/i);
  const slashPrefix = slashPrefixMatch ? slashPrefixMatch[1] : null;
  useEffect(() => {
    if (slashPrefix !== null && slashHasSkills) {
      setSlashOpen(true);
    } else if (slashPrefix === null) {
      setSlashOpen(false);
    }
  }, [slashPrefix, slashHasSkills]);

  // Filtered skills for the popover — full list when opened by button with no
  // prefix, or narrowed when the user is typing a prefix like "/c".
  const filteredSkills = useMemo(() => {
    if (!busSkills) return [];
    if (slashPrefix === null || slashPrefix === '') return busSkills;
    return busSkills.filter((s) =>
      s.trigger.toLowerCase().startsWith(`/${slashPrefix.toLowerCase()}`),
    );
  }, [busSkills, slashPrefix]);
  const filteredSkillsRef = useRef<BusSkillRow[]>([]);
  useEffect(() => {
    filteredSkillsRef.current = filteredSkills;
    if (filteredSkills.length > 0) setSlashFocused(0);
    else setSlashFocused(-1);
  }, [filteredSkills]);

  // P3.46 — outside-click / Esc dismissal for the @ popover. Same shape as the
  // slash popover (P3.45) and cli dropdown — players learn one popover language.
  useEffect(() => {
    if (!atOpen) {
      setAtFocused(-1);
      return;
    }
    setAtFocused(0);
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest('.cb-at')) setAtOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setAtOpen(false);
        return;
      }
      const list = agentMentionsRef.current ?? [];
      const total = list.length;
      if (total === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAtFocused((i) => (i < 0 ? 0 : (i + 1) % total));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAtFocused((i) => (i <= 0 ? total - 1 : i - 1));
      } else if (e.key === 'Enter') {
        const idx = atFocusedRef.current;
        if (idx < 0 || idx >= total) return;
        e.preventDefault();
        insertAgentMention(list[idx].id);
      }
    };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [atOpen]);

  // P3.46 — insert `@<id> ` at the textarea cursor. Mirrors insertSkillTrigger
  // (P3.45) so both popovers feel identical when used.
  const insertAgentMention = (agentId: string) => {
    const insertion = `@${agentId} `;
    setAtOpen(false);
    const r = ref.current;
    if (r) {
      r.focus();
      r.insertText(insertion);
    } else {
      setText((t) => `${t}${insertion}`);
    }
  };

  const atHasMentions = !!(agentMentions && agentMentions.length > 0);

  // P3.48 — open Bus admin and expand the given plugin row. Reuses the
  // pendingBusExpandId pipeline (P2.7f) shared with cb-mbsel-arrow / wb-* tab
  // placeholder / AgentsPanel bus pill / cli dropdown so popover deep-links
  // feel identical across all surfaces.
  const openInBusAdmin = (pluginId: string) => {
    setPendingBusExpandId(pluginId);
    openSettings('plugins');
    setAtOpen(false);
    setSlashOpen(false);
  };
  const onArrowKey = (e: React.KeyboardEvent<HTMLSpanElement>, pluginId: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      openInBusAdmin(pluginId);
    }
  };

  // 2026-05-21 — cb-mbsel popover keyboard nav / outside-click / pickModel 写盘
  // 全部下放到 <ModelPicker mode="single" writeToAgent={...}/>。Composer 这边只
  // 负责拿到当前 selected 显示在按钮上，并把 onChange 同步到本地 agentModel state
  // 兜底（picker 内部已经写过盘）。
  const cliButtonLabel = compactProviderLabel(currentLabel, providerOverride);
  useEffect(() => {
    if (!isStreaming) ref.current?.focus();
  }, [isStreaming]);

  // Pending pill insertion bridge — any surface (right-click → "引用到 Chat") can
  // call requestComposerInsert(pill); we consume it here, drop the chip at the
  // current caret, then clear the slot.
  //
  // We defer one rAF so the Radix DropdownMenu has fully closed and browser focus
  // has returned to the contenteditable before we try to insert at the caret.
  // Without the defer, window.getSelection() may still point at the menu overlay,
  // causing insertNodeAtCaret to fall back to end-of-content or silently skip.
  const composerPendingInsert = useAppStore((s) => s.composerPendingInsert);
  const clearComposerPendingInsert = useAppStore((s) => s.clearComposerPendingInsert);
  useEffect(() => {
    if (!composerPendingInsert) return;
    const id = requestAnimationFrame(() => {
      const r = ref.current;
      if (!r) {
        // Composer not mounted yet (ChatPanel closed) — leave the pending pill in
        // the store; it will be picked up on the next mount of this component.
        return;
      }
      r.focus();
      r.insertPill(composerPendingInsert);
      clearComposerPendingInsert();
    });
    return () => cancelAnimationFrame(id);
  }, [composerPendingInsert, clearComposerPendingInsert]);

  // Queued messages for the active (sid, agentId) slot.
  const queueKey = activeSid && activeAgent ? `${activeSid}::${activeAgent}` : null;
  const queued = queueKey ? (queuedMessages[queueKey] ?? []) : [];
  // Interrupt-send is a forgeax-native primitive (EventQueue steer); the CLI
  // bridge has no equivalent, so only offer it on the native path.
  const canInterrupt = isStreaming && (providerOverride === null || providerOverride === 'forgeax');

  const onSubmit = async () => {
    const t = text.trim();
    if (!t) return;
    if (isStreaming) {
      // Agent is mid-turn — queue client-side. It flushes as its own turn when
      // the current turn ends (sequential, one turn per queued message).
      enqueueMessage(t);
      setText('');
      return;
    }
    setText('');
    await sendMessage(t);
  };

  // Interrupt the running turn and send `text` immediately (handoff: steer).
  const onInterrupt = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    void sendMessage(t, { handoff: 'steer' });
  };

  // Per-chip "send now" (↑): pull this queued message out of the queue and send
  // it immediately, jumping ahead of the rest. Mid-turn → steer-interrupt the
  // running turn; idle → plain send. The remaining queued items keep their
  // order and flush after this one's turn ends.
  const onQueuedSendNow = (q: { id: string; text: string }) => {
    dequeueMessage(q.id);
    void sendMessage(q.text, isStreaming && canInterrupt ? { handoff: 'steer' } : undefined);
  };

  // Per-chip "edit" (✎): pull the queued text back into the composer input for
  // editing and drop it from the queue. The user re-sends (or re-queues) it.
  const onQueuedEdit = (q: { id: string; text: string }) => {
    dequeueMessage(q.id);
    const r = ref.current;
    if (r) { r.setValue(q.text); r.focus(); } else { setText(q.text); }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter') return;
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Shift/Ctrl/Meta+Enter: let RichInput insert a <br> at the caret (it
    // handles linebreaks for us once we leave defaultPrevented unset).
    if (e.shiftKey || e.ctrlKey || e.metaKey) return;
    // If a popover is open with a focused row, let the window keydown listener
    // handle Enter (select the item) — don't submit.
    if ((slashOpen && slashFocused >= 0) || (atOpen && atFocused >= 0)) {
      e.preventDefault();
      return;
    }
    // Plain Enter: submit. preventDefault stops RichInput from inserting a
    // linebreak after us.
    e.preventDefault();
    void onSubmit();
  };

  return (
    <div className="composer">
      <div className="composer-card">
        {queued.length > 0 && (
          <div className="composer-queue" role="list" aria-label="Queued messages">
            <div className="composer-queue-head">
              <span className="composer-queue-tag">已排队 {queued.length}</span>
              <span className="composer-queue-sub">当前回复结束后依次发送</span>
              <button
                type="button"
                className="composer-queue-clear"
                title="清空队列"
                onClick={() => clearQueue()}
              >清空</button>
            </div>
            {queued.map((q, i) => (
              <div key={q.id} className="composer-queue-chip" role="listitem" title={q.text}>
                <span className="composer-queue-idx">{i + 1}</span>
                <span className="composer-queue-text">{q.text.length > 80 ? `${q.text.slice(0, 80)}…` : q.text}</span>
                <button
                  type="button"
                  className="composer-queue-act"
                  aria-label="编辑这条排队消息"
                  title="编辑 — 取回到输入框"
                  onClick={() => onQueuedEdit(q)}
                >
                  <Pencil size={13} />
                </button>
                <button
                  type="button"
                  className="composer-queue-act composer-queue-now"
                  aria-label="立即发送这条排队消息"
                  title={isStreaming ? '立即发送 — 打断当前回复，优先处理这条' : '立即发送这条'}
                  onClick={() => onQueuedSendNow(q)}
                >
                  <ArrowUp size={13} />
                </button>
                <button
                  type="button"
                  className="composer-queue-act composer-queue-x"
                  aria-label="移除这条排队消息"
                  title="移除"
                  onClick={() => dequeueMessage(q.id)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        <RichInput
        ref={ref}
        className="composer-input"
        placeholder={
          isStreaming
            ? '回复进行中 — 可继续输入,[Enter] 排队,当前回复结束后依次发送' + (canInterrupt ? ' · ⚡ 打断并立即发送' : '')
            : providerOverride
              ? `Type your game idea... [Enter] to send · [Ctrl/Shift+Enter] newline  →  via ${currentLabel}${overrideDown ? ' ⚠ (不可用)' : ''}`
              : 'Type your game idea... [Enter] to send · [Ctrl/Shift+Enter] for a new line.'
        }
        value={text}
        onChange={setText}
        onKeyDown={onKeyDown}
      />
      <div className="composer-bar">
        <div className="cb-left-group">
          <button className="cb-btn cb-soon" title="图片上传 — 即将上线" aria-disabled="true" type="button" onClick={() => setHintFor(CB_HINT.IMG)}>
            <Upload size={16} />
            {hintFor === CB_HINT.IMG && <span className="cb-hint" role="status">即将上线</span>}
          </button>
          <div className="cb-at">
            <button
              className={`cb-btn ${atHasMentions ? 'cb-at-btn' : 'cb-soon'}${atOpen ? ' is-open' : ''}`}
              title={
                atHasMentions
                  ? `Mention agent (${agentMentions!.length}) — 单击插入 @<agent> 到输入框`
                  : '@ 提示 — 即将上线'
              }
              aria-disabled={atHasMentions ? undefined : true}
              aria-expanded={atHasMentions ? atOpen : undefined}
              aria-haspopup={atHasMentions ? 'menu' : undefined}
              type="button"
              onClick={() => {
                if (atHasMentions) setAtOpen((v) => !v);
                else setHintFor(CB_HINT.AT);
              }}
            >
              <AtSign size={16} />
              {!atHasMentions && hintFor === CB_HINT.AT && <span className="cb-hint" role="status">即将上线</span>}
            </button>
            {atOpen && atHasMentions && (
              <div className="cb-at-menu" role="menu" aria-label="Agent mentions">
                <div className="cb-at-menu-head">
                  <span className="cb-at-menu-head-tag">AGENTS</span>
                  <span className="cb-at-menu-head-n">{agentMentions!.length}</span>
                  <span className="cb-at-menu-head-sub">marketplace + bus</span>
                </div>
                {agentMentions!.map((a, i) => (
                  <button
                    key={a.id}
                    type="button"
                    role="menuitem"
                    className={`cb-at-item${a.isMain ? ' is-main' : ''}${atFocused === i ? ' is-active' : ''}`}
                    onMouseEnter={() => setAtFocused(i)}
                    title={
                      a.inBus
                        ? `${a.name} · ${a.role} · 同时位于 bus host — 单击插入 @${a.id}`
                        : `${a.name} · ${a.role} — 单击插入 @${a.id}`
                    }
                    onClick={() => insertAgentMention(a.id)}
                  >
                    <span className={`cb-at-avatar cb-at-role-${a.role}`} aria-hidden="true">{a.avatar}</span>
                    <span className="cb-at-id">@{a.id}</span>
                    <span className="cb-at-name">{a.name}</span>
                    <span className="cb-at-role">{a.role}</span>
                    {a.inBus && <span className="cb-at-bus-pill" aria-label="bus host">bus</span>}
                    {a.inBus && a.busPluginId && (
                      <span
                        className="cb-at-arrow"
                        role="button"
                        tabIndex={0}
                        aria-label={`在 Bus 详情查看 ${a.busPluginId}`}
                        title={`在 Bus 详情查看 ${a.busPluginId} →`}
                        onClick={(e) => { e.stopPropagation(); e.preventDefault(); openInBusAdmin(a.busPluginId!); }}
                        onKeyDown={(e) => onArrowKey(e, a.busPluginId!)}
                      >→</span>
                    )}
                  </button>
                ))}
                <div className="cb-at-foot">↑↓ 选 · ⏎ 插入 @&lt;id&gt; · → 跳 Bus 详情 · Esc 关闭</div>
              </div>
            )}
          </div>
          <div className="cb-slash">
            <button
              className={`cb-btn ${slashHasSkills ? 'cb-slash-btn' : 'cb-soon'}${slashOpen ? ' is-open' : ''}`}
              title={
                slashHasSkills
                  ? `Bus skills (${busSkills!.length}) — 单击选触发命令插入到输入框`
                  : '斜杠命令 — 即将上线'
              }
              aria-disabled={slashHasSkills ? undefined : true}
              aria-expanded={slashHasSkills ? slashOpen : undefined}
              aria-haspopup={slashHasSkills ? 'menu' : undefined}
              type="button"
              onClick={() => {
                if (slashHasSkills) setSlashOpen((v) => !v);
                else setHintFor(CB_HINT.SLASH);
              }}
            >
              <SquareChartGantt size={16} />
              {!slashHasSkills && hintFor === CB_HINT.SLASH && <span className="cb-hint" role="status">即将上线</span>}
            </button>
            {slashOpen && slashHasSkills && filteredSkills.length > 0 && (
              <div className="cb-slash-menu" role="menu" aria-label="Bus skills">
                <div className="cb-slash-menu-head">
                  <span className="cb-slash-menu-head-tag">COMMANDS</span>
                  <span className="cb-slash-menu-head-n">{filteredSkills.length}</span>
                  <span className="cb-slash-menu-head-sub">{slashPrefix ? `matching /${slashPrefix}` : 'all'}</span>
                </div>
                {filteredSkills.map((s, i) => (
                  <button
                    key={`${s.pluginId}:${s.skillId}`}
                    type="button"
                    role="menuitem"
                    className={`cb-slash-item${slashFocused === i ? ' is-active' : ''}`}
                    onMouseEnter={() => setSlashFocused(i)}
                    title={
                      s.descZh
                        ? `${s.displayName} · ${s.pluginId}\n${s.descZh}\n— 单击插入 ${s.trigger}`
                        : `${s.displayName} · ${s.pluginId} — 单击插入 ${s.trigger}`
                    }
                    onClick={() => insertSkillTrigger(s.trigger)}
                  >
                    <span className="cb-slash-trigger">{s.trigger}</span>
                    <span className="cb-slash-name">{s.displayName}</span>
                    {s.descZh && (
                      <span className="cb-slash-desc">
                        {s.descZh.length > 60 ? `${s.descZh.slice(0, 60)}…` : s.descZh}
                      </span>
                    )}
                    <span
                      className="cb-slash-arrow"
                      role="button"
                      tabIndex={0}
                      aria-label={`在 Bus 详情查看 ${s.pluginId}`}
                      title={`在 Bus 详情查看 ${s.pluginId} →`}
                      onClick={(e) => { e.stopPropagation(); e.preventDefault(); openInBusAdmin(s.pluginId); }}
                      onKeyDown={(e) => onArrowKey(e, s.pluginId)}
                    >→</span>
                  </button>
                ))}
                <div className="cb-slash-foot">↑↓ 选 · ⏎ 插入触发 · → 跳 Bus 详情 · Esc 关闭</div>
              </div>
            )}
          </div>
          {/* Model picker is only meaningful for the forgeax NATIVE provider —
              every CLI provider (claude-code / codex / cursor-agent) drives its
              own model from its own config, so hide the picker entirely rather
              than show a disabled/misleading control. */}
          {isForgeaXNative && (
          <ModelPicker
            className="cb-mbsel"
            mode="single"
            variant="button"
            displayLabel={compactModelLabel(agentModel?.selected ?? modelLabel)}
            value={agentModel?.selected ?? null}
            onChange={(next) => {
              if (typeof next !== 'string') return;
              // ModelPicker 已经替我们写过 agent.json（writeToAgent 传了 sid+agentPath）。
              // 这里只把 selected 同步到本地 agentModel state,避免按钮 label 闪回旧值。
              setAgentModel((prev) =>
                prev
                  ? { ...prev, selected: next, chain: [next], raw: [next] }
                  : forgeaxSid && activeAgent
                    ? { sid: forgeaxSid, agentPath: activeAgent, selected: next, chain: [next], raw: [next] }
                    : prev,
              );
            }}
            writeToAgent={
              canSwitchModel && activeAgent && forgeaxSid
                ? { sid: forgeaxSid, agentPath: activeAgent }
                : null
            }
            fallbackLabel={modelLabel}
            disabled={!canSwitchModel || !activeAgent || !forgeaxSid}
            disabledReason={
              !canSwitchModel
                ? `当前走 ${providerOverride} 渠道,该 provider 自己决定模型;切到 forgeax 或 claude-code 渠道才能改 agent.json::models.model`
                : !activeAgent
                  ? '还没选 agent — 无法读 agent.json'
                  : !forgeaxSid
                    ? 'forgeax session 还在 boot'
                    : undefined
            }
            triggerTitle={
              activeAgent
                ? `当前 agent (${activeAgent}) → agent.json::models.model`
                : 'Model selector'
            }
          />
          )}
        </div>
        <div className="cb-right-group">
          <ContextRing />
          <div className="cb-cli">
            <button
              type="button"
              className={`cb-cli-btn ${providerOverride ? 'cb-cli-active' : ''} ${overrideDown ? 'cb-cli-warning' : ''}`}
              onClick={() => setCliOpen((v) => !v)}
              disabled={isStreaming}
              title={cliButtonTitle}
            >
              <Unplug size={16} />
              <span className="cb-cli-label">{cliButtonLabel}</span>
            </button>
            {cliOpen && (
              <div className="cb-cli-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className={`cb-cli-item ${!providerOverride ? 'is-current' : ''} ${cliFocused === 0 ? 'is-focused' : ''}`}
                  onClick={() => { setProviderOverride(null); setCliOpen(false); }}
                  onMouseEnter={() => setCliFocused(0)}
                >
                  <span className="cb-cli-id">forgeax</span>
                  <span className="cb-cli-hint">
                    原生 · 消息直发 Session/EventBus（默认）
                    {activeAgent && <span style={{ opacity: 0.6 }}> ({activeAgent})</span>}
                  </span>
                </button>
                {providers.map((p, idx) => {
                  const busEntry = busCliMap.get(p.id);
                  return (
                  <button
                    key={p.id}
                    type="button"
                    role="menuitem"
                    className={`cb-cli-item ${providerOverride === p.id ? 'is-current' : ''} ${!p.health.ok ? 'is-down' : ''} ${cliFocused === idx + 1 ? 'is-focused' : ''} ${busEntry ? 'has-bus-desc' : ''}`}
                    onClick={() => {
                      setProviderOverride(p.id);
                      setCliOpen(false);
                    }}
                    onMouseEnter={() => setCliFocused(idx + 1)}
                    title={p.health.detail ?? ''}
                  >
                    <span className="cb-cli-row">
                      <span className="cb-cli-id">{p.id}</span>
                      <span className="cb-cli-name">
                        {p.displayName}
                        {!p.health.ok && p.health.detail && (
                          <span className="cb-cli-reason"> · {p.health.detail.slice(0, 100)}{p.health.detail.length > 100 ? '…' : ''}</span>
                        )}
                      </span>
                      {busEntry && (
                        <span
                          role="button"
                          tabIndex={0}
                          className="cb-cli-bus-pill is-link"
                          title={`bus plugin: ${BUS_CLI_ID_PREFIX}${p.id} · 单击在 Bus 详情查看 →`}
                          onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            setPendingBusExpandId(`${BUS_CLI_ID_PREFIX}${p.id}`);
                            openSettings('plugins');
                            setCliOpen(false);
                          }}
                          onKeyDown={(e) => {
                            if (e.key !== 'Enter' && e.key !== ' ') return;
                            e.stopPropagation();
                            e.preventDefault();
                            setPendingBusExpandId(`${BUS_CLI_ID_PREFIX}${p.id}`);
                            openSettings('plugins');
                            setCliOpen(false);
                          }}
                        >
                          bus →
                        </span>
                      )}
                      <span className={p.health.ok ? 'cb-cli-pill ok' : 'cb-cli-pill down'}>
                        {p.health.ok ? '✓' : 'DOWN'}
                      </span>
                    </span>
                    {busEntry && busEntry.descZh && (
                      <span
                        className="cb-cli-desc"
                        title={`description.zh from bus manifest: ${busEntry.descZh}`}
                      >
                        {busEntry.descZh}
                      </span>
                    )}
                  </button>
                  );
                })}
              </div>
            )}
          </div>
          {isStreaming ? (
            <>
              {text.trim() && canInterrupt && (
                <button
                  className="cb-send cb-interrupt"
                  title="打断当前回复并立即发送（steer）"
                  type="button"
                  onClick={onInterrupt}
                >
                  <Zap size={14} />
                </button>
              )}
              {text.trim() && (
                <button
                  className="cb-send cb-queue"
                  title="排队发送 — 当前回复结束后依次执行（[Enter]）"
                  type="button"
                  onClick={() => void onSubmit()}
                >
                  <ArrowUp size={16} />
                </button>
              )}
              <button
                className="cb-send cb-stop"
                title="停止当前回复（不影响已排队消息）"
                type="button"
                onClick={() => cancelStream()}
              >
                <Square size={12} />
              </button>
            </>
          ) : (
            <button
              className="cb-send"
              title={
                !activeSid
                  ? 'session 还在加载 — 稍等一秒；如果一直卡住，看右下角 server 是否 down'
                  : !activeAgent
                  ? '还没选 agent — 等 AgentSwitcher 列表加载（通常 <1s），或手动点上方 agent 头像'
                  : 'Send'
              }
              type="button"
              disabled={!text.trim() || !activeAgent || !activeSid}
              onClick={() => void onSubmit()}
            >
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
