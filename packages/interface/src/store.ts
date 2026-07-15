import { create } from 'zustand';
import { t } from '@/i18n';
import { peek } from './lib/bus';
import { alertDialog } from './lib/dialog';
import { createObservabilityState } from './store-parts/observability';
import { createShellState } from './store-parts/shell';
import { getSessionClient } from './store-parts/session-client';
import { getWorkbenchClient, hasWorkbenchClient } from './store-parts/workbench-client';
import { mostRecentSid, pickActiveSid } from './store-parts/session-pick';
import {
  cleanupLegacySessionKeys,
  loadActiveSid,
  loadAgentBySid,
  loadProviderOverride,
  persistActiveSid,
  persistAgentBySid,
  saveProviderOverride,
} from './store-parts/persistence';
import { getWindowManager, surfaceKey, type SurfaceDescriptor } from './lib/platform';
import { bootAppMode } from './lib/workbenches';
import { STORAGE_KEYS } from './lib/storageKeys';
import { getLastModel } from './lib/model-prefs';
import { resolveKernelForAgent } from './lib/agent-cli-provider';

export { configureSessionClient, type SessionClient } from './store-parts/session-client';
export {
  configureWorkbenchClient,
  getWorkbenchClient,
  type WorkbenchClient,
  type WorkbenchAgent,
  type WorkbenchAgentsResponse,
  type EngineRootCandidate,
  type GameRow,
  type AndroidConfig,
  type PackageGameOptions,
  type PackageJobStatus,
  type HistoryRecord,
  type CleanPackageResult,
} from './store-parts/workbench-client';

// P2.6d — 'bus' joins as a top-level mode for the Bus admin panel.
// Mirrors the Viewport / Workbench switch in the TopBar; rendered by MainArea.
// 2026-06-30: 'preview'/'play' removed; 'edit' retained as the 2x2 viewport workspace (OOS-5).
// 2026-07-07 (T3): AI workbench mode id renamed 'workbench' → 'ai'.
// 2026-07-07 (T4): AI workbench tools-rail panel id renamed 'workbench' → 'tools'.
// 2026-07-08 (v9): Scene workbench mode id renamed 'edit' → 'scene' (id/name align).
export type AppMode = 'scene' | 'ai' | 'bus';

// ③ PreviewFile 已移到 @forgeax/ai-workbench/file-preview（L1 不再持有文件预览态）。

export interface ToolCall {
  callId: string;
  name: string;
  args: unknown;
  status: 'running' | 'done' | 'error';
  result?: string;
  error?: string;
  // Snapshot of m.text.length when this tool-call event arrived. Lets the UI
  // render tool chips inline at their chronological position in the response
  // (mimicking vag_web's parts[] flow) instead of dumping all chips at the end.
  at?: number;
  /** When this tool_call is `name='subagent'`, the launched sub-agent's id.
   *  ForgeCard uses this to associate the chip with the inline SubAgentCard
   *  rendered from chatMsg.subAgents[subagentId]. */
  subagentId?: string;
}

export interface LiveAgent {
  path: string;
  display: string;
  parent: string | null;
  running: boolean;
  depth: number;
}

export interface AgentFileTouch {
  callId: string;
  path: string;
  name: string;
  op: string;
  ts: number;
  status: 'running' | 'done' | 'error';
}

export interface ConsoleEntry {
  level: 'log' | 'warn' | 'error' | 'info' | 'debug';
  text: string;
  ts: number;
}

export interface NetworkEntry {
  kind: 'fetch' | 'xhr' | 'ws';
  method: string;
  url: string;
  status: number;
  ms: number;
  ok: boolean;
  ts: number;
}

// ── Observability (trace + log) telemetry ───────────────────────────────────
// Wire shapes MIRROR `@forgeax/types`'s observability schema (SpanData /
// LogRecord / TelemetryRecord). interface has no dep on @forgeax/types, so the
// line shape is re-declared locally as plain TS (Schema-as-Contract lives in
// packages/types; this is the consumer-side view). Both信道 feed the SAME slice:
//   - node→server→WS  `{ type:'telemetry',     records }`  (bootBroadcast, R5/P1)
//   - iframe→shell     `{ type:'VAG_TELEMETRY', records }`  (healthBridge)
// 见 .claude/docs/架构设计/forgeax-os/可观测性-trace-log-v3-B档-并行执行计划-2026-06-24.md §B。
export interface TelemetrySpan {
  kind: 'span';
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTs: number;
  /** 缺失 = provisional(onStart 临时态),渲染成「进行中」。 */
  endTs?: number;
  provisional?: boolean;
  attrs?: Record<string, unknown>;
  events?: Array<{ name: string; ts: number; attrs?: Record<string, unknown> }>;
  status?: { code: 'ok' | 'error'; message?: string };
  sid?: string;
  agentId?: string;
}

export interface TelemetryLog {
  kind: 'log';
  ts: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  fields?: Record<string, unknown>;
  traceId?: string;
  spanId?: string;
  sid?: string;
  agentId?: string;
}

export type TelemetryRecord = TelemetrySpan | TelemetryLog;

export interface SubAgentRun {
  emitterId: string;
  text: string;
  thinking?: string;
  toolCalls: ToolCall[];
  status: 'streaming' | 'done' | 'error';
  startedAt: number;
  /** Which CliProvider streamed this run (forgeax, claude-code, ...).
   *  Surfaced as a badge on <SubAgentCard>. Per docs/CLI-PROVIDERS-DESIGN.md. */
  providerId?: string;
}

/**
 * Time-ordered segment of an assistant message — text / thinking / tool —
 * rendered in arrival order so reasoning, tool calls and prose interleave
 * the way they actually streamed.
 *
 *   ts             arrival timestamp (ms epoch); sort key for the render
 *   kind=text      append-only markdown chunk
 *   kind=thinking  append-only reasoning/thinking chunk
 *   kind=tool      tool call (lifecycle: running → done/error); same id is
 *                  reused as args/result deltas land
 *
 * Adjacent same-kind segments (text/thinking) are coalesced into one chunk
 * by `appendChatSegment`, so the array stays short even on multi-thousand
 * token streams.  Tool segments never coalesce — each call gets its own.
 */
export type ChatSegment =
  | { kind: 'text'; ts: number; text: string }
  | { kind: 'thinking'; ts: number; text: string }
  | { kind: 'tool'; ts: number; tool: ToolCall };

/** System message visual categories — matches ink-renderer's SystemLine.
 *  Used when role === 'system' to drive icon/color in ChatPanel.
 *
 *  - direction: 来信(incoming, 📨) / 出信(outgoing, 📤) — inter-agent traffic
 *  - level:     info / warning(⚠) / error(✖)
 *  - source:    short tag e.g. "agent:foo(inbound_message)", rendered before ':'
 *  - from / to: agent ids (purely informational; UI may show as subtitle) */
export type SystemLevel = 'info' | 'warning' | 'error';
export type SystemDirection = 'incoming' | 'outgoing';

/** One client-side queued message awaiting its turn (Cursor-style queue). */
export interface QueuedMessage {
  id: string;
  text: string;
  ts: number;
}

/** Options for sendMessage. `handoff: 'steer'` performs an interrupt-send:
 *  the message is delivered immediately with EventQueue handoff 'steer', which
 *  aborts the running turn and processes the new message next — instead of
 *  queueing it behind the current turn. */
export interface SendMessageOpts {
  handoff?: 'steer';
  /** 多模态附件(图片)。每项 `{ kind:'image', mediaType, data(base64 或 dataUrl) }`。
   *  透传进 /api/sessions/:sid/messages 的 payload → 内核 facade 组 image block(forgeax-core)。 */
  attachments?: Array<Record<string, unknown>>;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  /** checkpoint 回退点外键(role='user' 才有;server /messages 注入并回传)。
   *  有它且 server 侧存在对应 checkpoint 记录时,气泡 hover 出「回到这里」。 */
  msgId?: string;
  text: string;
  thinking?: string;
  toolCalls: ToolCall[];
  /** role='system' visual classification — drives icon / color in ChatPanel. */
  level?: SystemLevel;
  direction?: SystemDirection;
  /** role='system' — short source tag (e.g. `admin(message)`) printed inline. */
  source?: string;
  /** role='system' — emitter agent id, for inter-agent traffic. */
  from?: string;
  /** role='system' — recipient agent id, for inter-agent traffic. */
  to?: string;
  /** Time-ordered render units — text / thinking / tool interleaved.  When
   *  populated ForgeCard renders from this instead of the legacy
   *  text+thinking+toolCalls three-field layout, fixing the bug where tools
   *  visually "jump" because their position is anchored to a snapshot of
   *  text length rather than to their own timestamp.  Built by both the
   *  live SSE pipeline and the replay path. */
  segments?: ChatSegment[];
  /** Sub-agent runs that spawned during this turn — keyed by emitterId. */
  subAgents?: Record<string, SubAgentRun>;
  status: 'streaming' | 'done' | 'error';
  ts: number;
  errorMessage?: string;
  /** Which CliProvider streamed the main message (forgeax / claude-code / ...).
   *  Captured from payload.providerId on the first main-emitter event. */
  providerId?: string;
  /** Final cost (USD) of this turn — populated from SSE 'done' if provider
   *  surfaced it (currently only claude-code's result.total_cost_usd). */
  cost?: number;
  /** Wall-clock duration (ms) of this turn — populated from SSE 'done' when
   *  provider includes duration_ms. Falls back to local elapsed otherwise. */
  durationMs?: number;
}

/**
 * One chat thread tab.
 *
 * 2026-05-20 重做（彻底版）：
 *  - 此前 tab 是独立前端实体（id 是前端 newId、threadId/sessionId 可为 null、
 *    localStorage 持久化整张 tabs 数组），跟后端 sessions 形成「双重账本」——
 *    session 删了 tab 还在、boot 创了 session 但 tab.threadId 还是 null、
 *    `?? 'forgeax'` fallback 等一切恶心问题的根源。
 *  - 新模型：**每个 tab 就是一个 server session 的视图**。`sid` 是非空主键、
 *    DOM key、`_abortByTab` key、WS routing key —— 单一标识。
 *    - `id / threadId / sessionId / title` 字段全部下线。
 *    - boot 时不再造任何"无 sid scratch tab"。tabs 完全等于 GET /api/sessions
 *      的派生 view；空 → store action `initSessions` 自动建一条；CRUD 全部
 *      走后端 REST（POST/DELETE /api/sessions）。
 *    - localStorage 只缓存 `forgeax.activeSid`，不再持久化 tabs 数组本身。
 *      老 key (`forgeax.tabs`/`forgeax.activeTabId`) 启动一次性 cleanup。
 */
export interface ChatTab {
  /** Server session id —— 唯一主键。tab 与 session 一一对应。 */
  sid: string;
  /** Server 端 session.json::displayName。可能 undefined（boot-time auto-create
   *  / 用户没传名）—— UI 渲染规则：`tab.displayName ?? \`session ${sid.slice(0,6)}\``。
   *  改名等 server 端 PATCH 接口落地后接，先只读。 */
  displayName: string | undefined;
  /** Which agent this tab is bound to. First-class key for chat state:
   *  every WAL replay, every live-SSE routing decision, the AgentSwitcher
   *  highlight, the Composer hint — all derive from this. null means
   *  "fresh tab, no agent chosen yet"; the AgentSwitcher fills it in once
   *  list_agents resolves (defaulting to the root agent). */
  agentId: string | null;
  providerOverride: string | null;
  /** Epoch ms of the session's last on-disk activity (server-side: newest
   *  mtime under `<session>/agents/`). Mirrored from GET /api/sessions on
   *  initSessions / refreshSessions. Drives SessionSwitcher dropdown's
   *  recency sort + "X 分钟前" meta. Undefined for tabs that came back
   *  without the field (older server / pre-write race). */
  lastActivityAt?: number;
}

/** UI label fallback for a tab whose server-side displayName is undefined.
 *  Single helper so all surfaces (TabStrip / SessionSwitcher / TopBar) render
 *  the same string and we never reintroduce a hardcoded "default" anywhere. */
export function tabLabel(tab: Pick<ChatTab, 'sid' | 'displayName'>): string {
  const n = tab.displayName?.trim();
  return n && n.length > 0 ? n : `session ${tab.sid.slice(0, 6)}`;
}

export interface AppState {
  // ── UI mode ──
  mode: AppMode;
  setMode: (m: AppMode) => void;

  // P2.6a — widened from a closed union to `string` because the Sidebar TOOLS
  // row now mixes built-in tabs (`agents`/`files`) with bus-sourced workbench
  // plugin ids (e.g. `wb:character`, `wb:skill`). The set is open and grows
  // as new wb-* manifests land in packages/marketplace/extensions/.
  workbenchTab: string;
  setWorkbenchTab: (t: string) => void;

  // 2026-05-21 — When a workbench plugin opts into MainArea takeover (its
  // panel is bigger than what fits in the Sidebar — iframe-embedded editors
  // like wb-character), tile click sets this slot instead of workbenchTab.
  // MainArea/WorkbenchMode.tsx early-returns a full-bleed plugin host when
  // this is non-null; null = show the default workbench gallery / editor.
  workbenchExpandedExtensionId: string | null;
  setWorkbenchExpandedExtensionId: (id: string | null) => void;

  // 2026-06 (architecture review §B3) — workbenchTab (sidebar nav) and
  // workbenchExpandedExtensionId (center takeover) used to be set by separate
  // calls on every "open a plugin" path; missing one desynced the sidebar
  // left pane from the center (the left-pane-blank class of bug). openWorkbench
  // is the ONE atomic action every open path funnels through, so the two fields
  // can never drift. (The low-level setters above remain only for the center
  // "返回工作台" collapse, which clears expandedExtensionId while keeping the tab.)
  //   tab               — sidebar tab to activate ('agents' | 'files' | 'wb:<id>')
  //   expandedExtensionId  — plugin to expand into the center, or null (none).
  //                       Omit to leave the current center plugin untouched.
  openWorkbench: (opts: { tab?: string; expandedExtensionId?: string | null }) => void;

  // ── Windowing (detached OS windows) ──
  // Set of surface keys (see lib/platform/surface.ts `surfaceKey`) currently
  // hosted in their own OS window instead of the main window's keep-alive
  // layer. A surface is either `docked` (absent here, hosted in-window via
  // keep-alive) or `floating` (present here, hosted in a Tauri WebviewWindow).
  // While floating, the main window MUST NOT also render its keep-alive iframe
  // (that would spin up a second 3D engine / WS for the same surface), so
  // KeepAliveExtensionIframes filters these out.
  //
  // Browser form: detach is a no-op (WindowManager.canDetach() === false), so
  // this map stays empty and behavior is unchanged.
  floatingSurfaces: Record<string, true>;
  detachSurface: (d: import('./lib/platform').SurfaceDescriptor, opts?: { title?: string }) => Promise<void>;
  redockSurface: (d: import('./lib/platform').SurfaceDescriptor) => Promise<void>;
  /** Plugin IDs currently open as top-level DockShell panels (so Sidebar knows
   *  to hide their keep-alive iframes to avoid double-rendering). */
  dockedExtensions: Set<string>;
  addDockedExtension: (id: string) => void;
  removeDockedExtension: (id: string) => void;
  /** Internal: called by the WindowManager close listener (see main.tsx) when
   *  the user closes a detached window — redocks without re-closing the window. */
  markSurfaceDocked: (key: string) => void;

  // R5/P2 — 跨-surface 深链槽（原 ~7 个 pending*）已全部移出 store，改走 L1 bus
  // （lib/deep-link-bus.ts：emitDeepLink / useDeepLink，retain 快照语义）。producer
  // `emitDeepLink('bus:expand-plugin'|'bus:filter-kind'|'sidebar:focus-plugin'|
  // 'sidebar:flash-kind'|'chat:flash-bus-chip', ...)`；consumer `useDeepLink(topic)`。
  // 彻底死掉的 pendingRunsDateFilter（无 producer/consumer）直接删除。
  // Composer 的 "右键 → 在对话中引用" 桥在 lib/composer-bridge.ts；chat 消息流在 chat app。

  activeSession: string;
  setActiveSession: (s: string) => void;

  /** Pin an agent to a tab (key = sid). The single mutator for tab↔agent
   *  binding; every history-replay / live-routing / UI-highlight derives from
   *  `tabs.find(t => t.sid === activeSid)?.agentId`.
   *
   *  Side effect: also writes into `agentBySid[sid]` so the next time anyone
   *  navigates to that sid (tab switch / session pick / boot restore) we
   *  restore this exact agent, parity with ref ink-renderer
   *  `dataSource.writeCachedAgent(instanceId, agent)`. */
  setTabAgent: (sid: string, agentId: string | null) => void;

  /** Per-sid agentPath cache, mirror of ref's `agentByInstance` (renderer-cache-store).
   *  Restored on boot from localStorage so switching back to a session
   *  re-selects the agent the user last chose for that session, instead of
   *  defaulting to root (or worse — leaking the previous session's pick). */
  agentBySid: Record<string, string>;
  /** Read cache w/ guarded null fallback. */
  getCachedAgentForSid: (sid: string | null) => string | null;

  // ── Workbench file preview（③ 已抽到 @forgeax/ai-workbench/file-preview,走 bus 'workbench:files'）──
  // openFiles/activeFilePath/openFile/activateFile/closeFile/updatePreviewContent/savePreviewFile
  // 不再进 L1 store。壳侧打开文件走 bus 命令 'workbench:open-file'（见 workbench/file-preview.ts）。

  // ── Pinned active game (user's explicit selection; null = auto-detect) ──
  pinnedSlug: string | null;
  setPinnedSlug: (s: string | null) => void;

  // ── Current chat session id (bug #2 fix). null = let server auto-generate
  //    a fresh `sess-<timestamp>` for the next message. Set when we receive
  //    agent-start (echoed by server) or via the SessionSwitcher / NewMenu.
  currentSessionId: string | null;
  setCurrentSessionId: (id: string | null) => void;

  /** Per-(sid, agentId) streaming/busy flag, mirrored from the chat app so L1
   *  registry surfaces (SessionSwitcher / AgentsPanel) can render a spinner
   *  without importing chat message state. Owned by chat via setAgentBusy. */
  busyByAgentBySid: Record<string, Record<string, boolean>>;
  setAgentBusy: (sid: string, agentId: string, busy: boolean) => void;

  // ── Console buffer from engine iframe (VAG_CONSOLE postMessage) ──
  consoleLog: ConsoleEntry[];
  pushConsole: (entry: ConsoleEntry) => void;
  clearConsole: () => void;

  // ── Network buffer from engine iframe (VAG_NETWORK postMessage) ──
  networkLog: NetworkEntry[];
  pushNetwork: (entry: NetworkEntry) => void;
  clearNetwork: () => void;

  // ── Telemetry buffer (trace spans + structured logs) ──
  //  Fed by two信道 into ONE slice: node telemetry over WS
  //  (`{type:'telemetry'}`, bootBroadcast R5/P1) and iframe telemetry over
  //  postMessage (`{type:'VAG_TELEMETRY'}`, healthBridge). Span + log records
  //  live together (split by `kind` in the viewer). Capped at 500 (S4).
  telemetry: TelemetryRecord[];
  pushTelemetry: (records: TelemetryRecord[]) => void;
  clearTelemetry: () => void;

  // ── Persistent cli provider override (composer cli-selector) ──
  /** When set, every chat turn is routed via this CliProvider id regardless of
   *  the agent's manifest-declared provider. Stays until user explicitly
   *  switches back to 'forgeax' (null) via the dropdown —— null 即 R3 之后的
   *  默认原生路径（POST /api/sessions/:sid/messages 直发 EventBus）。 */
  providerOverride: string | null;
  setProviderOverride: (id: string | null) => void;

  // ── Agent chat reply language (global, persisted; decoupled from UI locale) ──
  /** Language the agent is asked to reply in. Global across sessions, persisted.
   *  Default 'en'. When `followInput` is on, the detected language of each user
   *  message takes precedence (resolved per-turn in the chat send path). */
  replyLanguage: 'en' | 'zh';
  /** Highest-priority rule: reply language follows the detected language of the
   *  user's input. Global, persisted, default true. */
  followInput: boolean;
  /** Pure setter for the reply language (keeps followInput as-is). */
  setReplyLanguage: (lang: 'en' | 'zh') => void;
  setFollowInput: (on: boolean) => void;
  /** Explicit language pick from the quick switcher / three-dot menu: pins the
   *  reply language AND turns followInput OFF (the user's manual choice wins). */
  pinReplyLanguage: (lang: 'en' | 'zh') => void;

  // ── Agent install prefs（① 已抽到 @forgeax/settings/agent-prefs，走 bus 'prefs:agents'）──
  // defaultBootstrapAgent / uninstalledAgentIds 不再进 L1 store —— 见 settings/agent-prefs.ts。

  // ── Live agent state (driven by WS events + list_agents poll) ──
  liveAgents: Record<string, LiveAgent[]>;
  agentFileActivity: Record<string, Record<string, AgentFileTouch[]>>;
  setLiveAgents: (sid: string, agents: LiveAgent[]) => void;
  pushFileTouch: (sid: string, agentPath: string, touch: AgentFileTouch) => void;
  updateFileTouchStatus: (sid: string, agentPath: string, callId: string, status: 'done' | 'error') => void;

  // ── Sessions（= tabs，2026-05-20 重做后是同一个东西）──
  /** All open sessions, rendered as chat tabs. Strictly derived from server
   *  `GET /api/sessions`. boot 调用 initSessions 拉 list / 必要时建一条；之后
   *  的 CRUD（新建 / 删除 / 切换 / pin agent）都通过 store actions，store 是
   *  唯一真值源 —— 没有"无 sid 的 scratch tab"，没有"session 没了 tab 还在"。 */
  tabs: ChatTab[];
  /** 当前活跃的 sid。tabs 至少有一个时，必落在 tabs.map(t=>t.sid) 里。
   *  null 仅在 boot 中间态 / server 端 sessions 真为空 + auto-create 失败时出现。 */
  activeSid: string | null;
  /** boot-time 初始化：拉 GET /api/sessions → 列表非空就用 [activeSid 或 [0]]；
   *  列表为空就 POST /api/sessions { autoStart: true } 建一条（不传 displayName /
   *  defaultDir，让 server 端缺省决定）。完成后调 connectForgeaXWs 把 WS 连上
   *  active sid。可重入 —— 多次调只跑一次（_initSessionsPending 内部 dedupe）。 */
  initSessions: () => Promise<void>;
  /** 新建 session = POST /api/sessions → push 进 tabs → 切过去。`displayName` 不
   *  传时让 server 端落 undefined（UI 走 tabLabel 占位规则）。失败返回 null。 */
  createNewSession: (opts?: {
    displayName?: string;
    defaultDir?: string;
    providerOverride?: string | null;
  }) => Promise<{ sid: string } | null>;
  /** 切到指定 sid。tab 必须已存在（不存在就先 refreshSessions 拉一下）。
   *  内部触发：mirror 切换 / WS 重连 / persist activeSid / agentBySid 缓存恢复。 */
  switchToSession: (sid: string) => Promise<void>;
  /** 关闭并删除 session。abort in-flight stream → DELETE /api/sessions/:sid →
   *  remove from tabs → 切到剩余的第一条；空了就再 createSession 建一条新的
   *  （保证总有一个 active session 可用）。 */
  closeSession: (sid: string) => Promise<void>;
  /** 重新拉一遍 server sessions 列表，merge 进 tabs（保留本地 messages / 各 tab
   *  in-flight 状态）。手动刷新 / 切换后兜底用。 */
  refreshSessions: () => Promise<void>;
  /** 切换当前 game（GameSwitcher.onPick 与新建 game 共用）：pin → 设为 server active
   *  game（使新建 session 绑对）→ 按该 game 收口刷新 session 列表 → 落到最近活跃的一条；
   *  该 game 0 条 session 时自动新建一条（"新建 game 必带 session"）。 */
  switchGame: (slug: string) => Promise<void>;
  renameTab: (sid: string, displayName: string) => void;
  /** L3 sub-agent switcher (P6d step d). For tabs with a server-side thread,
   *  PATCH /api/threads/:id { activeEmitterId } so the next /api/chat turn
   *  in this tab gets routed to the picked emitter. Side-effect-only — no
   *  immediate UI change beyond a status indication. */
  setActiveEmitter: (emitterId: string) => Promise<void>;

  // ── Overlay（通用壳级 overlay 槽 · R5/P5 去名化）──
  //  L1 壳只有一个通用 overlay 槽，不 hardcode app 名：
  //   - `activeOverlay` = 当前打开的 overlay id（调用方传 'settings' / 'dashboard' / …；
  //      store 不认识这些具体值，只当字符串存）。null = 无 overlay。
  //   - `overlayParam` = 该 overlay 的可选参数（如 settings 的 section nav id）。
  //  取代原按 app 命名的 `dashboardOpen` / `settingsOpen` / `settingsSection`。
  //  section 的持久化（关掉再开回到上次 tab）保留在壳级 pref 里。
  activeOverlay: string | null;
  overlayParam: string | null;
  /** 打开一个 overlay（可带参数；param 省略时沿用上次，主要给 settings section 用）。 */
  openOverlay: (id: string, param?: string) => void;
  /** 改当前 overlay 的参数（如 settings 面板里切换 nav section）。 */
  setOverlayParam: (param: string | null) => void;
  closeOverlay: () => void;

  // ── Fullscreen ("immersive" mode) ──
  //
  // Hides TopBar / Sidebar / ChatPanel / StatusBar so MainArea fills the
  // viewport. Toggled via Ctrl+Shift+F (see lib/global-shortcuts.ts) or
  // the Settings → Shortcuts section. Esc also exits.
  fullscreen: boolean;
  setFullscreen: (v: boolean) => void;
  toggleFullscreen: () => void;

  // ── Sidebar / ChatPanel collapse (kept separate from width drag) ──
  //
  // Toggled via Ctrl+Shift+B / Ctrl+Shift+C. The actual width is owned by
  // useLocalSize hooks in App.tsx — these flags layer on top and hide the
  // pane via CSS without losing the drag-restored width.
  sidebarCollapsed: boolean;
  chatpanelCollapsed: boolean;
  toggleSidebar: () => void;
  toggleChatpanel: () => void;
}

// Chat message/event-engine logic lives in @forgeax/chat. L1 keeps only the
// session registry and injected session-client contract used by shell chrome.

// turnsToChatMessages removed — replay no longer goes through batch
// onTurn/CompletedTurn flatten. Both live and replay now feed events into
// TurnAccumulator in arrival order; the callbacks (buildMain/SubCallbacks)
// mutate the ChatMessage model through MessageEffects (live: store; replay:
// in-memory). This is the only way `tc.at` placement matches live, because
// onMessage(tool_call) sees the same m.text.length snapshot in both paths.


// Cross-tab sync: when a sibling tab writes to PROVIDER_OVERRIDE_KEY, push
// the new value into our zustand state so the cli-selector button rerenders
// without a manual reload. Without this, two open tabs drift — tab A shows
// 'auto' even though localStorage already says 'claude-code' (tick 224 hunt).
// The 'storage' event only fires for sibling tabs, not the writer tab; that
// path uses setProviderOverride directly.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== 'forgeax.providerOverride') return;
    const next = e.newValue && e.newValue !== 'null' ? e.newValue : null;
    if (useShellStore.getState().providerOverride !== next) {
      useShellStore.setState({ providerOverride: next });
    }
  });
}

// ── Agent chat reply language (global + persisted, cross-tab synced) ──────────
function loadReplyLanguage(): 'en' | 'zh' {
  try {
    return localStorage.getItem(STORAGE_KEYS.replyLanguage) === 'zh' ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}
function saveReplyLanguage(lang: 'en' | 'zh'): void {
  try { localStorage.setItem(STORAGE_KEYS.replyLanguage, lang); } catch { /* ignore */ }
}
function loadFollowInput(): boolean {
  try {
    // Default ON: only an explicit '0' disables it.
    return localStorage.getItem(STORAGE_KEYS.followInput) !== '0';
  } catch {
    return true;
  }
}
function saveFollowInput(on: boolean): void {
  try { localStorage.setItem(STORAGE_KEYS.followInput, on ? '1' : '0'); } catch { /* ignore */ }
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEYS.replyLanguage) {
      const next = e.newValue === 'zh' ? 'zh' : 'en';
      if (useShellStore.getState().replyLanguage !== next) useShellStore.setState({ replyLanguage: next });
    } else if (e.key === STORAGE_KEYS.followInput) {
      const next = e.newValue !== '0';
      if (useShellStore.getState().followInput !== next) useShellStore.setState({ followInput: next });
    }
  });
}

// agent 安装偏好（DEFAULT_INSTALLED_AGENT_IDS / uninstalled / bootstrap / seed）已
// 整体抽到 @forgeax/settings/agent-prefs（① · 走 bus 'prefs:agents'）—— L1 不再持有。

// R5/P1 — the broadcast `/ws` daemon socket moved OUT of the store's module-load
// side-effect into the shared `lib/broadcast-stream` primitive, wired at boot by
// `boot/broadcast.ts` (`bootBroadcast()`). Importing the store no longer opens a
// socket. telemetry / workspace-changed handling lives in bootBroadcast; daemon-tick
// is chat's (subscribeDaemonTick). See docs 17b §7.2.

// ── Sessions persistence ───────────────────────────────────────────────────
// 2026-05-20 重做：不再持久化 tabs 数组本身（tabs = GET /api/sessions 派生）。
// 只持久化 activeSid（用户上次看的是哪条），boot 时再 init。同时一次性清掉
// 老 key (forgeax.tabs / forgeax.activeTabId) 防止旧数据残留。
cleanupLegacySessionKeys();

/** Persisted per-sid agent cache —— ref ink-renderer `agentByInstance` 移植。
 *  对外只暴露 read / write 两个动作；boot 时一次性 load 当 init state，runtime
 *  写盘交给 `setTabAgent` 的副作用。 */
/** Patch a session tab's registry field (key = sid). Mirrors providerOverride
 *  to the top-level default when the patched tab is active. Chat message state
 *  no longer lives on the tab — it's owned by the chat app's session store. */
function patchTabField(
  state: AppState,
  sid: string,
  patch: Partial<Pick<ChatTab, 'providerOverride' | 'displayName'>>,
): Partial<AppState> {
  const tabs = state.tabs.map((t) => (t.sid === sid ? { ...t, ...patch } : t));
  const out: Partial<AppState> = { tabs };
  if (state.activeSid === sid && patch.providerOverride !== undefined) {
    out.providerOverride = patch.providerOverride;
  }
  return out;
}

/** initSessions in-flight dedupe —— React StrictMode 双 mount / HMR 重载时 effect
 *  会跑两次，避免对 server 发两次重复 POST。promise 完成后清回 null，下次有需要
 *  可重新初始化（手动 reset 等）。 */
let _initSessionsPending: Promise<void> | null = null;

/** Pull active agent's running 真值并同步到 tab.isStreaming —— 解决"前端 ws 连上
 *  时后端 agent 早就在跑（错过 turnStart）→ UI 仍以为 idle"这种臆想态。
 *
 *  调用时机：boot / refresh / 切 active session / 新建 session / 关闭兜底新建 ——
 *  即每次 `connectForgeaXWs(sid)` 的紧后面。增量靠 hook:turnStart/turnEnd 事件，
 *  这里只补"WS 连上一刻的快照"。
 *
 *  失败 / sid null 静默 —— 网络/server 抖动时 UI 维持上一份状态，下次切换再拉。 */
async function _syncActiveAgentRunning(sid: string | null): Promise<void> {
  if (!sid) return;
  try {
    const { listSessionAgents } = getSessionClient();
    const agents = await listSessionAgents(sid);
    if (agents.length === 0) return;
    // tab.agentId 还没绑（cached === null）→ 用 depth=1 root 兜底。
    //
    // 已绑但 cached id 不在 list_agents 里（典型场景：用户刚点了 mochi/iro
    // 这种 marketplace persona，server 端还没收到首条消息触发自动 scaffold，
    // session.tree 暂时见不到该 agent）—— **保留** 用户的 pin，不要 kick 回 root。
    // 这条规则与 AgentSwitcher 的 auto-pin 逻辑（line 202-208）保持一致：pin
    // 是 user intent，list_agents 没观察到 ≠ 该 pin 无效。早先这里强制重指 root
    // 正是用户报的「点击 mochi 头像但 forge/root 接管对话」bug 的源头之一。
    const root = agents.find((a) => a.depth === 1)?.path ?? agents[0]!.path;
    const tab = useShellStore.getState().tabs.find((t) => t.sid === sid);
    const cached = tab?.agentId ?? null;
    const cachedInTree = cached ? agents.some((a) => a.path === cached) : false;
    const wantPath = cached ? cached : root;
    const target = agents.find((a) => a.path === wantPath);
    // Marketplace pin not yet observed in tree (cached but not in agents):
    // wantPath === cached but `target` is undefined. We still want to keep
    // the pin and show running:false until the auto-scaffold lands. No
    // tab.messagesByAgent rewiring needed since the pin is unchanged.
    useShellStore.setState((s) => {
      // Only update agentBySid when we're filling a previously-empty slot.
      // Keeping a marketplace pin: cached !== null already => leave as-is.
      const agentBySid = cached ? s.agentBySid : { ...s.agentBySid, [sid]: wantPath };
      const tabs = s.tabs.map((t) => (t.sid === sid ? { ...t, agentId: wantPath } : t));
      return { tabs, agentBySid };
    });
    if (!cached) persistAgentBySid(useShellStore.getState().agentBySid);
  } catch (e) {
    console.warn('[syncActiveAgentRunning] failed', (e as Error).message);
  }
}

// Initial top-level mirror at module load. boot 时 tabs 是空的、activeSid 来自
// localStorage 但还没验证（initSessions 跑完才知道这个 sid 还在不在）。React
// 启动后第一次 effect 调 initSessions() 拉 server / 必要时 createSession，
// 然后 set tabs + activeSid，UI 才真亮起来（ChatPanel 在 tabs 为空时渲染空态/
// loading）。
const _initialActiveSid = loadActiveSid();
const _initialMirror = {
  tabs: [] as ChatTab[],
  activeSid: _initialActiveSid,
  currentSessionId: _initialActiveSid,
  providerOverride: loadProviderOverride(),
};

// R5/P1 — daemon-tick/telemetry/workspace-changed WS handling moved off the store
// module-load side-effect. telemetry + workspace-changed now wired via
// `boot/broadcast.ts` (bootBroadcast); daemon-tick is chat's (subscribeDaemonTick).

export const useShellStore = create<AppState>((set, get) => ({
  ...createShellState(set, get),
  // R5/P2 — deep-link slots moved to L1 bus (lib/deep-link-bus.ts); removed from store.
  setTabAgent: (sid, agentId) => {
    set((s) => {
      const tabs = s.tabs.map((t) => (t.sid === sid ? { ...t, agentId } : t));
      // sid 总是有效（=tab 主键），直接写 agentBySid 缓存。agentId=null 时显式
      // delete 这个 key，保持 map 紧凑（避免 stale 残留）。
      const agentBySid = { ...s.agentBySid };
      if (agentId) agentBySid[sid] = agentId;
      else delete agentBySid[sid];
      persistAgentBySid(agentBySid);
      return { tabs, agentBySid };
    });
    if (agentId) {
      void resolveKernelForAgent(agentId).then((kernelId) => {
        // 只有解析出具体 CLI 内核 id 的显式 CLI persona(cc-coder /
        // claude-code-default / codex-default 等)才反写全局 provider ——
        // 这是"CLI as subagent persona"要的行为。kernelId === null 意味着
        // `forgeax-native` 或无偏好,而 forgeax-native 是几乎所有普通 agent
        // (forge / iori / suzu…)manifest 里的脚手架默认值,不是用户意图:
        // 把它当权威偏好会在 AgentSwitcher 自动 pin root、或点普通 agent
        // 页签时,把用户在 Settings › Providers 手选的内核静默冲回 native
        // 并写盘(体感即"内核设置没有持久化")。全局 provider 的 SSOT 是
        // 用户的 Settings 选择,native 缺省不覆盖它。
        if (!kernelId) return;
        useShellStore.setState((s) => {
          const tab = s.tabs.find((t) => t.sid === sid);
          if (!tab || tab.agentId !== agentId) return {};
          const patch = patchTabField(s, sid, { providerOverride: kernelId });
          if (s.activeSid === sid) {
            saveProviderOverride(kernelId);
            return { ...patch, providerOverride: kernelId };
          }
          return patch;
        });
      });
    }
  },

  agentBySid: loadAgentBySid(),
  getCachedAgentForSid: (sid) => {
    if (!sid) return null;
    return get().agentBySid[sid] ?? null;
  },
  // providerOverride 是全局单一设置（Settings › Providers）：写盘当默认 + mirror 到
  // active tab 仅作记录。switchToSession 不再从 tab 反向拉 provider（会让 Settings 激活值
  // 随 session 乱跳），切 session 只对齐模型、不动全局 provider。
  replyLanguage: loadReplyLanguage(),
  followInput: loadFollowInput(),
  setReplyLanguage: (lang) => {
    saveReplyLanguage(lang);
    set({ replyLanguage: lang });
  },
  setFollowInput: (on) => {
    saveFollowInput(on);
    set({ followInput: on });
  },
  pinReplyLanguage: (lang) => {
    // Manual pick wins: pin the language and stop following the input language.
    saveReplyLanguage(lang);
    saveFollowInput(false);
    set({ replyLanguage: lang, followInput: false });
  },

  setProviderOverride: (id) => {
    saveProviderOverride(id);
    set((s) => {
      if (!s.activeSid) return { providerOverride: id };
      return { providerOverride: id, ...patchTabField(s, s.activeSid, { providerOverride: id }) };
    });
  },
  // ① agent 安装偏好的写操作已移到 @forgeax/settings/agent-prefs（toggleAgentInstalled /
  // setAgentInstalled / setDefaultBootstrapAgent），走 bus 'prefs:agents'。L1 不再持有。
  // currentSessionId 在重做后等价 activeSid（一一对应），setter 保留只是为了不
  // 破已有 import surface —— 但实际真正切 session 应该走 switchToSession()。这里
  // 只 mirror top-level 字段、不动 activeSid（防止误用导致状态机错乱）。
  setCurrentSessionId: (id) => {
    set({ currentSessionId: id });
  },

  busyByAgentBySid: {},
  setAgentBusy: (sid, agentId, busy) => set((s) => {
    if (!sid || !agentId) return {};
    const perSid = s.busyByAgentBySid[sid] ?? {};
    if (Boolean(perSid[agentId]) === busy) return {};
    const nextPerSid = { ...perSid };
    if (busy) nextPerSid[agentId] = true;
    else delete nextPerSid[agentId];
    return { busyByAgentBySid: { ...s.busyByAgentBySid, [sid]: nextPerSid } };
  }),



  ...createObservabilityState(set),

  liveAgents: {},
  agentFileActivity: {},
  setLiveAgents: (sid, agents) => set((s) => ({
    liveAgents: { ...s.liveAgents, [sid]: agents },
  })),
  pushFileTouch: (sid, agentPath, touch) => set((s) => {
    const perSid = s.agentFileActivity[sid] ?? {};
    const prev = perSid[agentPath] ?? [];
    const deduped = prev.filter((f) => f.path !== touch.path || f.callId === touch.callId);
    return {
      agentFileActivity: {
        ...s.agentFileActivity,
        [sid]: { ...perSid, [agentPath]: [...deduped, touch] },
      },
    };
  }),
  updateFileTouchStatus: (sid, agentPath, callId, status) => set((s) => {
    const perSid = s.agentFileActivity[sid];
    if (!perSid) return s;
    const prev = perSid[agentPath];
    if (!prev) return s;
    const next = prev.map((f) => (f.callId === callId ? { ...f, status } : f));
    return {
      agentFileActivity: {
        ...s.agentFileActivity,
        [sid]: { ...perSid, [agentPath]: next },
      },
    };
  }),

  pinnedSlug: (() => {
    try { return localStorage.getItem('forgeax.pinnedSlug') || null; } catch { return null; }
  })(),
  setPinnedSlug: (s) => {
    try { if (s) localStorage.setItem('forgeax.pinnedSlug', s); else localStorage.removeItem('forgeax.pinnedSlug'); } catch { /* ignore */ }
    set({ pinnedSlug: s });
  },

  // ③ 文件预览态实现整体移到 @forgeax/ai-workbench/file-preview(走 bus 'workbench:files')。

  // ── Tab-aware messages/streaming state (P6 step 1) ──
  // The data lives in `tabs[active].messages` etc.; these top-level fields
  // are a *mirror* of the active tab for back-compat with components that
  // already do `useShellStore(s => s.messages)`. Initial values come from the
  // persisted-tabs loader so the first render sees the right tab content.
  //
  // Note: TS narrows spread types to optional; we re-state the literal fields
  // below so all required AppState slots are present at init time. The earlier
  // `providerOverride: null` / `currentSessionId: null` declarations are then
  // overridden by the spread.
  ..._initialMirror,


  initSessions: async () => {
    if (_initSessionsPending) return _initSessionsPending;
    _initSessionsPending = (async () => {
      const { fetchSessionList, createSession, connectForgeaXWs } = getSessionClient();
      try {
        // 列表恒按当前 game 收口（pinnedSlug；null 时 server 回落 active game）。
        let scope = get().pinnedSlug ?? undefined;
        let metas = await fetchSessionList(scope);
        if (metas.length === 0 && scope && hasWorkbenchClient()) {
          // 收口为空且带着本地 pin —— pin 可能已陈旧（game 被删/改名后 localStorage
          // 残留）。server 的 active game 才是 SSOT：先纠偏再重查。否则下面的真空
          // 兜底会新建一条 session（server 端绑到 active game，跟这里的 scope 并不
          // 一致），用户看到的就是"刷新后历史消失、聊天变成全新空会话"。
          const activeSlug = await getWorkbenchClient().getActiveSlug()
            .then((r) => r.activeSlug)
            .catch(() => null);
          if (activeSlug && activeSlug !== scope) {
            get().setPinnedSlug(activeSlug);
            scope = activeSlug;
            metas = await fetchSessionList(scope);
          }
        }
        if (metas.length === 0) {
          // 真空态：兜底建一条。**不**传 displayName / defaultDir —— 让 server 端
          // 缺省决定，UI 走 tabLabel 占位规则反映"无名"真值，不再硬塞 default。
          const { sid } = await createSession({ autoStart: true });
          metas = await fetchSessionList(scope);
          // 兜底：如果 list 里居然没看到刚建的（应该不会，但 fs-watcher race 等
          // 极端情况），手动补一条 meta 进去保证 UI 有 tab。
          if (!metas.some((m) => m.sid === sid)) {
            metas = [{ sid }, ...metas];
          }
        }
        const newTabs: ChatTab[] = metas.map((m) => ({
          sid: m.sid,
          displayName: m.displayName,
          agentId: get().agentBySid[m.sid] ?? null,
          providerOverride: get().providerOverride,
          lastActivityAt: m.lastActivityAt,
        }));
        // localStorage 上次的 active sid 优先（如果还在 list 里），否则最近活跃的
        // 一条（规则见 session-pick.ts）。
        const active = pickActiveSid(newTabs, loadActiveSid());
        // provider 是全局设置，绝不从 tab 反推（会随 active session 乱跳）。
        set({
          tabs: newTabs,
          activeSid: active,
          currentSessionId: active,
        });
        persistActiveSid(active);
        connectForgeaXWs(active);
        void _syncActiveAgentRunning(active);
      } catch (e) {
        console.error('[initSessions] failed', e);
        // boot 失败：UI 维持空 tabs，ChatPanel 渲染空态 + 让用户手点"重试 / 新建"。
        set({ tabs: [], activeSid: null });
      }
    })();
    try { await _initSessionsPending; } finally { _initSessionsPending = null; }
  },

  refreshSessions: async () => {
    const { fetchSessionList } = getSessionClient();
    try {
      // 同 initSessions：按当前 game 收口（pinnedSlug；null → server 回落 active game）。
      const metas = await fetchSessionList(get().pinnedSlug ?? undefined);
      set((s) => {
        const byOldSid = new Map(s.tabs.map((t) => [t.sid, t] as const));
        const merged: ChatTab[] = metas.map((m) => {
          const existing = byOldSid.get(m.sid);
          if (existing) {
            // server 端 displayName / lastActivityAt 可能改了 —— 同步更新；
            // 其余 in-flight 状态保留。
            const stale = existing.displayName === m.displayName
              && existing.lastActivityAt === m.lastActivityAt;
            return stale
              ? existing
              : { ...existing, displayName: m.displayName, lastActivityAt: m.lastActivityAt };
          }
          return {
            sid: m.sid,
            displayName: m.displayName,
            agentId: s.agentBySid[m.sid] ?? null,
            providerOverride: s.providerOverride,
            lastActivityAt: m.lastActivityAt,
          };
        });
        // 如果 active 还在新 list 里就保留，否则掉到最近活跃的一条（规则见
        // session-pick.ts）。空 list → null。
        const active = pickActiveSid(merged, s.activeSid);
        persistActiveSid(active);
        // provider 全局，不从 tab 反推。
        return {
          tabs: merged,
          activeSid: active,
          currentSessionId: active,
        };
      });
    } catch (e) {
      console.warn('[refreshSessions] failed', e);
    }
  },

  switchGame: async (slug) => {
    // 一条机制,GameSwitcher.onPick 与新建 game 共用:pin → 设 server active game(使
    // 后续新建 session 绑到该 game)→ 按 game 收口刷新列表 → 落最近活跃一条/空则新建。
    get().setPinnedSlug(slug);
    try {
      await getWorkbenchClient().activateGame(slug);
    } catch (e) {
      // pin 已切了 preview/agents,但 server 没记下 active game —— 显式报出而非默默
      // 让 session scope 错位。仍继续刷新(server 端 fallback 会按旧 active game 收口)。
      void alertDialog({
        title: t('gameSwitcher.activateFailedTitle'),
        body: t('gameSwitcher.activateFailedBody', { slug, message: (e as Error).message }),
      });
    }
    await get().refreshSessions();
    const tabs = get().tabs;
    if (tabs.length === 0) {
      // 该 game 还没有 session(新建 game / 从未用过)→ 自动建一条,保证总有可用 session。
      await get().createNewSession();
      return;
    }
    // D1:落到最近活跃的一条（规则见 session-pick.ts）。switchToSession 会重连
    // WS,故无条件调(refreshSessions 只改 tabs/activeSid,不重连 WS)。
    const recent = mostRecentSid(tabs);
    if (recent) await get().switchToSession(recent);
  },

  createNewSession: async (opts) => {
    const { createSession, connectForgeaXWs } = getSessionClient();
    try {
      // ① defaultBootstrapAgent 来自 settings/agent-prefs 的 bus 快照（L1 不再持有）。
      const bootstrap = (peek('prefs:agents') as { defaultBootstrapAgent?: string | null } | undefined)
        ?.defaultBootstrapAgent ?? null;
      const { sid, bootstrappedAgent } = await createSession({
        // 用户主动在 UI 里建 session（点 + 新建），可以传一个语义化的 displayName。
        // 不传时让 server 端落 undefined（UI 自己用 tabLabel 占位反映"无名"）。
        displayName: opts?.displayName,
        // pinnedSlug 是用户主动选的 game-project，作为新 session 的 game 默认值合理。
        defaultDir: opts?.defaultDir ?? (get().pinnedSlug ?? undefined),
        autoStart: true,
        // 用户在 Settings → Agents 里指定的「新 session 默认 agent」。null 时让
        // server 走 DEFAULT_BOOTSTRAP_AGENT='root'。是 marketplace persona id
        // 时 sessions.ts 解析 personaFile 注入到新 scaffold 的 agent.json。
        ...(bootstrap ? { bootstrapAgent: bootstrap } : {}),
      });
      const seedOverride = opts?.providerOverride !== undefined
        ? opts.providerOverride
        : get().providerOverride;
      // Seed the bootstrapped agent's model. The scaffold default is
      // AGENT_DEFAULTS.models.model (claude-opus-4-8), which is fine for the
      // native path but wrong for a CLI driver (that id isn't in the driver's
      // catalog). Precedence:
      //   1. the model the user last HAND-PICKED for this provider (model-prefs)
      //      — "new session resumes where I left off";
      //   2. else, for a CLI driver, its catalog default (first non-hidden) so
      //      the model belongs to the active provider;
      //   3. else (native, nothing remembered) leave the scaffold default.
      // Only cases 1/2 write; awaited-before-activate so the composer never
      // flashes a stale id; best-effort so a catalog hiccup can't block create.
      if (bootstrappedAgent) {
        try {
          const catalogProviderId =
            seedOverride && seedOverride !== 'forgeax' ? seedOverride : null;
          const remembered = getLastModel(catalogProviderId);
          if (remembered || catalogProviderId) {
            const { listModels, setAgentModels } = await import('./lib/model-config');
            const catalog = await listModels(catalogProviderId);
            const rememberedOk =
              !!remembered && catalog.some((m) => m.id === remembered && !m.hidden);
            const next = rememberedOk
              ? remembered
              : catalogProviderId
                ? (catalog.find((m) => !m.hidden)?.id ?? catalog[0]?.id)
                : undefined;
            if (next) await setAgentModels(sid, bootstrappedAgent, [next]);
          }
        } catch { /* best-effort — leave the scaffold default */ }
      }
      set((s) => {
        const newTab: ChatTab = {
          sid,
          displayName: opts?.displayName,
          agentId: null,
          providerOverride: seedOverride,
        };
        const tabs = [...s.tabs, newTab];
        persistActiveSid(sid);
        return {
          tabs,
          activeSid: sid,
          currentSessionId: sid,
          providerOverride: seedOverride,
        };
      });
      connectForgeaXWs(sid);
      void _syncActiveAgentRunning(sid);
      return { sid };
    } catch (e) {
      void alertDialog({ title: t('store.createSession.failedTitle'), body: (e as Error).message });
      return null;
    }
  },

  switchToSession: async (sid) => {
    const tab = get().tabs.find((t) => t.sid === sid);
    if (!tab) {
      // 不在 tabs 里 —— 可能其它地方刚建好但本地 list 还没刷新，refresh 再试。
      await get().refreshSessions();
      const t2 = get().tabs.find((tb) => tb.sid === sid);
      if (!t2) return;
    }
    const target = get().tabs.find((t) => t.sid === sid)!;
    // 切 session：把该 session 的模型对齐到「当前设置的 provider」。provider 是全局
    // 单一设置（Settings › Providers），但从盘上加载的 session（如切 game 带出的历史
    // 会话）其 agent.json 模型可能仍属于旧 provider。若不在当前 provider 的 catalog 里
    // → 切到该 provider 上次手选模型（model-prefs）或默认；已属于则不动。在翻 activeSid
    // 之前做，好让 composer 首帧 fetch 直接画对齐后的值（不闪旧模型）。best-effort，
    // 绝不因对齐失败阻断切换。
    const agentPath = target.agentId ?? get().agentBySid[sid] ?? null;
    if (agentPath) {
      try {
        const { reconcileSessionModelToActiveProvider } = await import('./lib/model-route');
        await reconcileSessionModelToActiveProvider(sid, agentPath);
      } catch { /* never block a session switch on model reconcile */ }
    }
    // provider 是全局单一设置（Settings › Providers；chat 内切换器已隐藏），切
    // session 绝不改动它——否则 Settings 的激活 provider 会跟着目标 tab 的历史值乱跳。
    // session 与全局 provider 的错配只对齐「模型」（上面 reconcile 已做），不动 provider。
    set({
      activeSid: sid,
      currentSessionId: sid,
    });
    persistActiveSid(sid);
    const { connectForgeaXWs } = getSessionClient();
    connectForgeaXWs(sid);
    void _syncActiveAgentRunning(sid);
  },

  closeSession: async (sid) => {
    // liveAgents / agentFileActivity 是按 sid 累积的 write-only map(session-stream
    // 与 AgentsPanel 轮询只增不删);关 session 必须随 tab 一起摘除,否则每个关闭的
    // session 都把整棵 agent 树 + 文件活动记录永久滞留在 store 里(内存泄漏 case-05)。
    const omitSessionResidue = (s: Pick<AppState, 'liveAgents' | 'agentFileActivity' | 'agentBySid' | 'busyByAgentBySid'>) => {
      const { [sid]: _la, ...liveAgents } = s.liveAgents;
      const { [sid]: _fa, ...agentFileActivity } = s.agentFileActivity;
      // case-06: agentBySid 也按 sid 累积,且 setTabAgent 把它持久化进 localStorage
      // ('forgeax.agentBySid')。关 session 不摘 → 孤儿条目在内存 + 磁盘双重无界
      // 累积、跨刷新永不回收。随 tab 一起摘掉并回写盘(与 setTabAgent 一致)。
      const { [sid]: _ab, ...agentBySid } = s.agentBySid;
      persistAgentBySid(agentBySid);
      // busy 镜像(chat 写)随 tab 一起摘,避免关闭 session 残留 spinner 标记。
      const { [sid]: _bb, ...busyByAgentBySid } = s.busyByAgentBySid;
      return { liveAgents, agentFileActivity, agentBySid, busyByAgentBySid };
    };
    // case-10: file-activity-stream 的模块级 _state Map 按 sid 累积(file-activity
    // 事件触发 getOrInit),只增不删 → 每个关闭的 session 永久滞留一个条目。随 tab
    // 一起摘除(与 closeThreadHistoryTails 同为 per-sid 模块清理)。
    void import('./lib/file-activity-stream').then((m) => m.dropFileActivitySession(sid));

    // 2. 真删盘 —— DELETE /api/sessions/:sid。失败也照常往下走（盘上残留比 UI
    //    幽灵 tab 还在更可接受），错误吐到控制台。
    const { deleteSession, connectForgeaXWs, createSession } = getSessionClient();
    try { await deleteSession(sid); }
    catch (e) { console.warn('[closeSession] DELETE failed', e); }

    // 3. 从 tabs 里摘掉。如果删的是最后一条 → server 立即再 createSession 兜底
    //    保证 UI 永远有一条可用 session，跟 initSessions 的"空就建一条"一致。
    const remainingMetas = get().tabs.filter((t) => t.sid !== sid);
    if (remainingMetas.length === 0) {
      try {
        const { sid: newSid } = await createSession({ autoStart: true });
        const fresh: ChatTab = {
          sid: newSid,
          displayName: undefined,
          agentId: null,
          providerOverride: loadProviderOverride(),
        };
        set((s) => ({
          tabs: [fresh],
          activeSid: newSid,
          currentSessionId: newSid,
          ...omitSessionResidue(s),
        }));
        persistActiveSid(newSid);
        connectForgeaXWs(newSid);
        void _syncActiveAgentRunning(newSid);
        return;
      } catch (e) {
        console.error('[closeSession] auto-create after empty failed', e);
        set((s) => ({ tabs: [], activeSid: null, currentSessionId: null, ...omitSessionResidue(s) }));
        persistActiveSid(null);
        connectForgeaXWs(null);
        return;
      }
    }

    set((s) => {
      const oldIdx = s.tabs.findIndex((t) => t.sid === sid);
      const newIdx = Math.max(0, oldIdx - 1);
      const next = remainingMetas[Math.min(newIdx, remainingMetas.length - 1)]!;
      persistActiveSid(next.sid);
      return {
        tabs: remainingMetas,
        activeSid: next.sid,
        currentSessionId: next.sid,
        ...omitSessionResidue(s),
      };
    });
    connectForgeaXWs(get().activeSid);
    void _syncActiveAgentRunning(get().activeSid);
  },

  renameTab: (sid, displayName) => {
    set((s) => patchTabField(s, sid, { displayName }));
    // TODO: 等 server 加 PATCH /api/sessions/:sid { displayName } 后写盘。当前
    // 只是 UI 临时改名，刷新会 revert 到 server 真值。
  },

  setActiveEmitter: async (emitterId) => {
    // 重做后 activeSid 就是 server-side thread id（一一对应，不再有"tab 没绑
    // session"中间态），所以直接用 activeSid 当 PATCH /api/threads/:id 的 key。
    const { activeSid } = get();
    if (!activeSid) {
      console.warn('[setActiveEmitter] no active session');
      return;
    }
    try {
      const r = await fetch(`/api/threads/${encodeURIComponent(activeSid)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ activeEmitterId: emitterId }),
      });
      if (!r.ok) {
        console.warn(`[setActiveEmitter] PATCH failed: HTTP ${r.status}`);
        return;
      }
      get().setTabAgent(activeSid, emitterId);
    } catch (e) {
      console.warn(`[setActiveEmitter] error: ${(e as Error).message}`);
    }
  },

}));

/**
 * @deprecated Renamed to `useShellStore` (T24 · ADR 0024). Kept as an alias
 * so out-of-tree consumers (chat / editor / workbench / dashboard / settings
 * / studio / harness — 74 callsites across 7 submodules) keep booting while
 * they migrate. Both names point to the SAME store instance; there is no
 * behavior difference. Remove this line once every submodule has been
 * repointed and pin-bumped in root.
 */
export const useAppStore = useShellStore;
