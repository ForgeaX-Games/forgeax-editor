import { create, type StateCreator } from 'zustand';
import { t } from '@/i18n';
import { parseSse } from './lib/sse';
import { recordLog } from './lib/logSink';
import { alertDialog } from './lib/dialog';
import { expandPills } from './components/Composer/pill';
import { TurnAccumulator } from './lib/event-engine/turn-accumulator';
import {
  parseEventLines,
  trimToCompactBoundary,
} from './lib/event-engine/event-replay';
import { applyRewindMask, findPendingRewind } from './lib/event-engine/rewind-mask';
import {
  buildMainCallbacks,
  buildSubCallbacks,
  finalizeStreamingStatus,
  makeInMemEffects,
  rendererToolCallToLegacy,
  type MessageEffects,
} from './lib/event-engine/message-builder';
import type {
  StoredEvent,
  ToolCallMessage,
} from './lib/event-engine/types';
import { getWindowManager, surfaceKey, type SurfaceDescriptor } from './lib/platform';
import { bootAppMode } from './lib/workspaces';

// P2.6d — 'bus' joins as a top-level mode for the Bus admin panel.
// Mirrors the Preview / Workbench switch in the TopBar; rendered by MainArea.
export type AppMode = 'preview' | 'workbench' | 'edit' | 'bus';

// Shared file descriptor used by the multi-tab workbench editor.
export interface PreviewFile {
  path: string;
  kind: 'text' | 'image' | 'audio' | 'video' | 'model' | 'binary';
  mime: string;
  bytes: number;
  content?: string;
  dirty?: boolean;
  error?: string;
}

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
//   - node→server→WS  `{ type:'telemetry',     records }`  (handleDaemonWs)
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
  /** Currently in-flight server-side `Run.id`. Captured from the first
   *  payload that carries `payload.runId` (chat.ts emits it on every frame
   *  after Run creation). Two consumers:
   *    1. cancelStream() — POSTs `/api/runs/<runId>/cancel` so the server
   *       actually aborts the cli subprocess (just abort()ing the client SSE
   *       leaves the server-side Run streaming to its jsonl).
   *    2. loadThreadHistory() — fills this in for refreshed tabs that
   *       inherit an unfinished run, so cancelStream still works after
   *       a page reload. */
  runId: string | null;
  providerOverride: string | null;
  /** Active-agent mirror of `messagesByAgent[agentId]`. Top-level UI selectors
   *  read this. Invariant: when `agentId === A`, `messages === messagesByAgent[A] ?? []`.
   *  Updated atomically with `messagesByAgent[A]` so the legacy single-slot
   *  consumers (sendMessage pre-push / loadThreadHistory / daemon-tick) keep
   *  working while session-stream / loadSession demux per-agent. */
  messages: ChatMessage[];
  /** Active-agent mirror of `streamingByAgent[agentId]`. Same invariant. */
  isStreaming: boolean;
  /** Per-agent message slots, keyed by `agentPath`. 2026-05-23 — Forge can
   *  delegate to mochi mid-stream; both run concurrently on the same `sid`.
   *  Without this multiplex, mochi's stream chunks land in Forge's last-
   *  streaming bubble (findStreamingAsst races on tab.messages tail) and
   *  switching to mochi during Forge's stall sees Forge's content because
   *  there's only one slot. */
  messagesByAgent: Record<string, ChatMessage[]>;
  /** Per-agent streaming flags. Same justification as messagesByAgent —
   *  hook:turnStart/turnEnd routes by emitterId, so each agent's spinner
   *  state is independent. */
  streamingByAgent: Record<string, boolean>;
  contextPct: number;
  /** Epoch ms of the session's last on-disk activity (server-side: newest
   *  mtime under `<session>/agents/`). Mirrored from GET /api/sessions on
   *  initSessions / refreshSessions. Drives SessionSwitcher dropdown's
   *  recency sort + "X 分钟前" meta. Undefined for tabs that came back
   *  without the field (older server / pre-write race). */
  lastActivityAt?: number;
  /** checkpoint 软回退挂起态(Cursor 语义)。非 null = 被回退段置灰显示中。 */
  pendingRewind: {
    boundaryId: string;
    targetMsgId: string;
    mode: 'both' | 'conversation' | 'code';
    keptDirty: string[];
    overwrite: { files: string[] } | null;
  } | null;
  /** 手改保留/覆盖通知(独立于 pendingRewind)。 */
  rewindDirtyNotice: {
    boundaryId: string;
    keptDirty: string[];
    overwrite: { files: string[] } | null;
  } | null;
  /** msgId → 是否有代码 checkpoint(GET /:sid/checkpoints)。 */
  checkpointMsgIds: Record<string, boolean>;
}

/** UI label fallback for a tab whose server-side displayName is undefined.
 *  Single helper so all surfaces (TabStrip / SessionSwitcher / TopBar) render
 *  the same string and we never reintroduce a hardcoded "default" anywhere. */
export function tabLabel(tab: Pick<ChatTab, 'sid' | 'displayName'>): string {
  const n = tab.displayName?.trim();
  return n && n.length > 0 ? n : `session ${tab.sid.slice(0, 6)}`;
}

interface AppState {
  // ── UI mode ──
  mode: AppMode;
  setMode: (m: AppMode) => void;

  // P2.6a — widened from a closed union to `string` because the Sidebar TOOLS
  // row now mixes built-in tabs (`agents`/`files`) with bus-sourced workbench
  // plugin ids (e.g. `wb:character`, `wb:skill`). The set is open and grows
  // as new wb-* manifests land in packages/marketplace/plugins/.
  workbenchTab: string;
  setWorkbenchTab: (t: string) => void;

  // 2026-05-21 — When a workbench plugin opts into MainArea takeover (its
  // panel is bigger than what fits in the Sidebar — iframe-embedded editors
  // like wb-character), tile click sets this slot instead of workbenchTab.
  // MainArea/WorkbenchMode.tsx early-returns a full-bleed plugin host when
  // this is non-null; null = show the default workbench gallery / editor.
  workbenchExpandedPluginId: string | null;
  setWorkbenchExpandedPluginId: (id: string | null) => void;

  // 2026-06 (architecture review §B3) — workbenchTab (sidebar nav) and
  // workbenchExpandedPluginId (center takeover) used to be set by separate
  // calls on every "open a plugin" path; missing one desynced the sidebar
  // left pane from the center (the left-pane-blank class of bug). openWorkbench
  // is the ONE atomic action every open path funnels through, so the two fields
  // can never drift. (The low-level setters above remain only for the center
  // "返回工作台" collapse, which clears expandedPluginId while keeping the tab.)
  //   tab               — sidebar tab to activate ('agents' | 'files' | 'wb:<id>')
  //   expandedPluginId  — plugin to expand into the center, or null (none).
  //                       Omit to leave the current center plugin untouched.
  openWorkbench: (opts: { tab?: string; expandedPluginId?: string | null }) => void;

  // ── Windowing (detached OS windows) ──
  // Set of surface keys (see lib/platform/surface.ts `surfaceKey`) currently
  // hosted in their own OS window instead of the main window's keep-alive
  // layer. A surface is either `docked` (absent here, hosted in-window via
  // keep-alive) or `floating` (present here, hosted in a Tauri WebviewWindow).
  // While floating, the main window MUST NOT also render its keep-alive iframe
  // (that would spin up a second 3D engine / WS for the same surface), so
  // KeepAlivePluginIframes filters these out.
  //
  // Browser form: detach is a no-op (WindowManager.canDetach() === false), so
  // this map stays empty and behavior is unchanged.
  floatingSurfaces: Record<string, true>;
  detachSurface: (d: SurfaceDescriptor, opts?: { title?: string }) => Promise<void>;
  redockSurface: (d: SurfaceDescriptor) => Promise<void>;
  /** Plugin IDs currently open as top-level DockShell panels (so Sidebar knows
   *  to hide their keep-alive iframes to avoid double-rendering). */
  dockedPlugins: Set<string>;
  addDockedPlugin: (id: string) => void;
  removeDockedPlugin: (id: string) => void;
  /** Internal: called by the WindowManager close listener (see main.tsx) when
   *  the user closes a detached window — redocks without re-closing the window. */
  markSurfaceDocked: (key: string) => void;

  // P2.7f — cross-component deep link from a Sidebar wb-* placeholder's "在
  // Bus 详情查看 →" button into the BusAdminPanel: set the plugin id here +
  // setMode('bus'), and BusAdminPanel reads/clears this on mount or whenever
  // it changes, auto-expanding that row and scrolling it into view. Null when
  // no pending request.
  pendingBusExpandId: string | null;
  setPendingBusExpandId: (id: string | null) => void;

  // 2026-05-17 — cross-component bridge for "右键 → 在对话中引用": any surface
  // (FilesPanel / AgentsPanel / Sidebar workbench tab / Preview / ...) can call
  // requestComposerInsert(pill) and the Composer's RichInput will pick it up
  // on its next render tick, insert the chip at the caret, then clear.
  // Uses a queue so batch "Add to AI Chat" (multi-select) inserts all pills.
  composerPendingInsert: import('./components/Composer/pill').PillPayload | null;
  composerPendingInsertQueue: import('./components/Composer/pill').PillPayload[];
  requestComposerInsert: (p: import('./components/Composer/pill').PillPayload) => void;
  clearComposerPendingInsert: () => void;

  // ── checkpoint 回退点 ──
  // 回退后把目标消息文本回填输入框(Cursor 同款体验);Composer 在渲染 tick
  // 消费后清空 —— 与 composerPendingInsert 同一桥接模式。
  composerPendingText: string | null;
  requestComposerText: (text: string) => void;
  clearComposerPendingText: () => void;
  /** GET /:sid/checkpoints → tab.checkpointMsgIds + tab.pendingRewind。 */
  loadCheckpoints: (sid: string) => Promise<void>;
  /** POST rewind;成功后由 rewind:done WS 事件落 UI 状态(单一事实源)。 */
  performRewind: (sid: string, msgId: string, mode: 'both' | 'conversation' | 'code') => Promise<void>;
  performRewindCancel: (sid: string) => Promise<void>;
  performOverwriteDirty: (sid: string) => Promise<void>;
  performUndoOverwrite: (sid: string) => Promise<void>;
  /** session-stream 收 rewind:* WS 事件后的状态落点。 */
  applyRewindEvent: (
    sid: string,
    kind: 'done' | 'cancelled' | 'finalized' | 'overwrite' | 'overwrite-undone',
    payload: Record<string, unknown>,
  ) => void;

  // P3.33 — reverse deep-link target from BusAdminPanel agent detail row's
  // "← 在 Sidebar 高亮" button into the Sidebar AgentsPanel. We store the bus
  // pluginId (the same key BusAdminPanel rows use) rather than the AgentRec.id,
  // because the AgentsPanel already knows the pluginId ⇄ agent id mapping via
  // agents_from_bus[].pluginId. AgentsPanel reads/clears this on flip,
  // scrolling the matching card into view and flashing it for ~1.5s. Null when
  // no pending request. Symmetric mate to pendingBusExpandId (P2.7f) — together
  // they wire Sidebar ⇄ Bus admin two-way navigation.
  pendingSidebarFocusPluginId: string | null;
  setPendingSidebarFocusPluginId: (id: string | null) => void;

  // P3.37 — deep-link target from Sidebar BUS KINDS footer 6-chip into the
  // BusAdminPanel kind filter. setMode('bus') + setPendingBusKindFilter('agent')
  // → BusAdminPanel reads this on mount/change and solos that kind (sets its
  // local enabledKinds = new Set([kind])), then clears the slot. Symmetric to
  // pendingBusExpandId (P2.7f, row expand) — both gate BusAdminPanel initial
  // view from a remote surface, but operate on different axes (kind filter vs
  // single row expand). Null when no pending request.
  pendingBusKindFilter: string | null;
  setPendingBusKindFilter: (kind: string | null) => void;

  // P3.38 — reverse mate to pendingBusKindFilter (P3.37). When the player
  // clicks a kind chip inside BusAdminPanel's filter row, we set this slot to
  // that kind; the Sidebar BUS KINDS footer reads it once, flashes the matching
  // .ss-kind-chip for ~1.5s (pulse + glow), then clears it. Confirms in the
  // peripheral surface "this kind is where you just acted" — same loop as
  // P3.33 (pendingSidebarFocusPluginId) but on the kind axis instead of agent
  // pluginId axis.
  pendingSidebarKindFlash: string | null;
  setPendingSidebarKindFlash: (kind: string | null) => void;

  // P3.40 — sibling to pendingSidebarKindFlash, but the receiving surface is
  // the ChatPanel TabStrip's .ts-bus-chip (the bus host count chip on the
  // right side of the screen). Triggered every time the player toggles a
  // plugin row in BusAdminPanel — we set this to the row's pluginId, TabStrip
  // pulses its bus-chip for ~0.8s (green peripheral confirmation), then clears.
  // 9th deep-link surface; first time a single-instance chip (not a per-kind
  // chip) takes a reverse flash signal, so we use a tick-bound string slot
  // instead of a kind selector. Value is informational only (TabStrip doesn't
  // read it for branching, just trigger detection).
  pendingChatPanelBusFlash: string | null;
  setPendingChatPanelBusFlash: (id: string | null) => void;

  // P3.70 — deep-link target from Analytics 7-day Run trend bars into the
  // Dashboard Runs sub-page. Bar click sets this to the day's UTC-local start
  // ms + label (e.g. {dayStartMs, dayLabel:"5-16"}); RunsList consumes it once
  // on mount/change, copies into a local dateFilter state, then clears the
  // slot. Filters the runs table to that single calendar day. 14th
  // expand-pipeline surface — first time a non-bus deep-link target lands
  // (target is sibling Dashboard sub-page, not BusAdminPanel).
  pendingRunsDateFilter: { dayStartMs: number; dayLabel: string } | null;
  setPendingRunsDateFilter: (f: { dayStartMs: number; dayLabel: string } | null) => void;

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

  // ── Workbench file preview (multi-tab) ──
  // `kind` drives the renderer in WorkbenchMode:
  //   text  → textarea (editable, savable)
  //   image → <img src=/api/files/raw?path=...>
  //   audio → <audio controls>
  //   video → <video controls>
  //   model → <model-viewer> (lazy)
  //   binary → unsupported notice + size
  // `content` is only present for kind==='text' (server skips decode for
  // binary kinds since 2026-05-17 — was producing PNG-as-mojibake before).
  openFiles: PreviewFile[];
  activeFilePath: string | null;
  openFile: (path: string) => Promise<void>;
  /** Inject a file descriptor directly without hitting /api/files (devtools / tests). */
  openFileDirect: (file: PreviewFile) => void;
  /** Switch focus to an already-open tab. No-op if path not in openFiles. */
  activateFile: (path: string) => void;
  /** Close a specific tab by path, or the active tab if path is omitted. */
  closeFile: (path?: string) => void;
  updatePreviewContent: (content: string) => void;
  savePreviewFile: () => Promise<{ ok: boolean; error?: string }>;

  // ── Pinned active game (user's explicit selection; null = auto-detect) ──
  pinnedSlug: string | null;
  setPinnedSlug: (s: string | null) => void;

  // ── WAL replay (events-N.jsonl is the canonical history source) ──
  /** Pull the (sid, agentPath) pair's events jsonl through fetch_session_events,
   *  trim to the most-recent compact_boundary, replay through TurnAccumulator
   *  and write the resulting ChatMessage[] into the bound tab.
   *
   *  R3 (2026-05-20): 跟 ref `loadSession(agentId)` 的差异是参数从 agentId 拆
   *  成 `(sid, agentPath)` —— forgeax 一个 sid 多 agent，ledger 与 `(sid,
   *  agentPath)` 一对一；ref 是一个 agentId 一份 session ledger。BFS 子 agent
   *  在 forgeax 这边也没意义：子 agent 各自有独立 ledger，渲染层未来想看子
   *  agent 历史另调一次 loadSession 即可。 */
  loadSession: (sid: string, agentPath: string) => Promise<void>;

  /**
   * Replay a chat thread's history from `/api/runs/<id>/events?stream=poll`.
   * Used for subprocess providers (claude-code / codex / cursor-agent) whose
   * events go to `.forgeax/runs/<runId>.jsonl` (AG-UI format), NOT to the
   * forgeax-cli `team/sessions/` ledger that `loadSession` reads.
   *
   * Without this, refreshing the studio while talking to the claude-code provider wipes the
   * conversation from the UI even though the run continues on the server
   * (visible in Dashboard).  See `forgeax-dev-diary/2026-05-17/` for the
   * root-cause report.
   */
  loadThreadHistory: (threadId: string) => Promise<void>;

  // ── Current chat session id (bug #2 fix). null = let server auto-generate
  //    a fresh `sess-<timestamp>` for the next message. Set when we receive
  //    agent-start (echoed by server) or via the SessionSwitcher / NewMenu.
  currentSessionId: string | null;
  setCurrentSessionId: (id: string | null) => void;

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
  //  (`{type:'telemetry'}`, handleDaemonWs) and iframe telemetry over
  //  postMessage (`{type:'VAG_TELEMETRY'}`, healthBridge). Span + log records
  //  live together (split by `kind` in the viewer). Capped at 500 (S4).
  telemetry: TelemetryRecord[];
  pushTelemetry: (records: TelemetryRecord[]) => void;
  clearTelemetry: () => void;

  // ── Chat thread (real, no fake) ──
  messages: ChatMessage[];
  isStreaming: boolean;
  sendMessage: (text: string, opts?: SendMessageOpts) => Promise<void>;
  // ── Message queue (Cursor-style "keep typing while streaming") ──
  /** Client-side queued messages, keyed by `${sid}::${agentId}`. While an
   *  agent's turn is streaming, new sends land here instead of going to the
   *  backend; each is flushed as its own turn on that agent's hook:turnEnd
   *  (see session-stream). Held client-side so they remain editable/removable
   *  before they actually run. */
  queuedMessages: Record<string, QueuedMessage[]>;
  /** Queue `text` for the active (sid, agentId). No-op without an active
   *  agent/session. Used by the Composer when the target agent is streaming. */
  enqueueMessage: (text: string) => void;
  /** Remove one queued message by id from the active (sid, agentId) slot. */
  dequeueMessage: (id: string) => void;
  /** Drop every queued message for the active (sid, agentId) slot. */
  clearQueue: () => void;
  /** Pop the oldest queued message for (sid, agentId) and actually send it.
   *  Called from session-stream on a natural turnEnd to chain the queue. */
  flushQueuedForAgent: (sid: string, agentId: string) => void;
  /** Abort the in-flight chat turn. Closes the SSE fetch → server.onAbort fires →
   *  provider.chat()'s AbortSignal triggers → subprocess SIGTERM'd. UI shows
   *  the partial assistant message with status='done'. */
  cancelStream: () => void;
  clearMessages: () => void;

  // ── Persistent cli provider override (composer cli-selector) ──
  /** When set, every chat turn is routed via this CliProvider id regardless of
   *  the agent's manifest-declared provider. Stays until user explicitly
   *  switches back to 'forgeax' (null) via the dropdown —— null 即 R3 之后的
   *  默认原生路径（POST /api/sessions/:sid/messages 直发 EventBus）。 */
  providerOverride: string | null;
  setProviderOverride: (id: string | null) => void;

  // ── Agent install/uninstall preferences ──
  /** Ids of agents the user has explicitly «卸载» from Settings → Agents.
   *  Default empty (= every agent listed by /api/workbench/agents is
   *  considered installed). ChatAgentStrip subtracts this set; main-agent
   *  delegate tool surface (server side) reads the parallel prefs file. */
  uninstalledAgentIds: string[];
  /** Toggle membership for a single agent id. Persists to localStorage and
   *  best-effort POSTs to `/api/prefs/uninstalled-agents` so server tools
   *  see the same view (see prefs router). */
  toggleAgentInstalled: (id: string) => void;
  /** Set membership explicitly. Same persistence as toggle. */
  setAgentInstalled: (id: string, installed: boolean) => void;
  /** Agent id to bootstrap when the user creates a new session. null = use
   *  server default (currently 'root'). When set to a marketplace persona id
   *  (mochi/iori/suzu/rin/…), server resolves persona and scaffolds with
   *  personaFile pre-filled (same auto-scaffold logic as POST /messages). */
  defaultBootstrapAgent: string | null;
  setDefaultBootstrapAgent: (id: string | null) => void;

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
  renameTab: (sid: string, displayName: string) => void;
  /** L3 sub-agent switcher (P6d step d). For tabs with a server-side thread,
   *  PATCH /api/threads/:id { activeEmitterId } so the next /api/chat turn
   *  in this tab gets routed to the picked emitter. Side-effect-only — no
   *  immediate UI change beyond a status indication. */
  setActiveEmitter: (emitterId: string) => Promise<void>;

  // ── Dashboard overlay ──
  dashboardOpen: boolean;
  setDashboardOpen: (open: boolean) => void;

  /** Settings panel overlay (replaces the old TopBar Bus mode tab + the
   *  right-slide SettingsDrawer).  Sections live in a registry filled by
   *  any number of `useSettingsSection({...})` callers (Plugins/Keys/
   *  Models/CliProviders/Workspace/Account/About …).  `settingsSection`
   *  is the currently-selected nav id; null lets the panel default to
   *  the highest-priority section on open. */
  settingsOpen: boolean;
  settingsSection: string | null;
  setSettingsOpen: (open: boolean) => void;
  setSettingsSection: (id: string | null) => void;
  /** Convenience — open the panel AND jump to a specific section in one
   *  call.  Every former `setMode('bus')` deep-link uses
   *  `openSettings('plugins')` (with optional pendingBus* slot prep). */
  openSettings: (section?: string) => void;

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

// rendererToolCallToLegacy moved to lib/event-engine/message-builder.ts —
// it is shared by live and replay paths so its home is colocated with the
// callback factories that use it (P6).

// turnsToChatMessages removed — replay no longer goes through batch
// onTurn/CompletedTurn flatten. Both live and replay now feed events into
// TurnAccumulator in arrival order; the callbacks (buildMain/SubCallbacks)
// mutate the ChatMessage model through MessageEffects (live: store; replay:
// in-memory). This is the only way `tc.at` placement matches live, because
// onMessage(tool_call) sees the same m.text.length snapshot in both paths.

function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * Fetch a session's raw ndjson WAL through forgeax-server's commands proxy.
 * Used by loadSession to pull main + every sub-agent's events. The proxy
 * forwards to cli daemon's `fetch_session_events` command which returns the
 * agent's latest session's events-N.jsonl as a single ndjson blob.
 *
 * Returns '' on any error (network, non-200, unparseable JSON) — caller
 * treats an empty fetch the same as a no-history agent (e.g. a freshly
 * spawned sub-agent whose first event hasn't been written yet).
 *
 * Known limitation: the command takes only agentId, returning the agent's
 * *latest* session. Multi-session per-agent scenarios may pull events from
 * a different session than the one the launching main turn referenced. The
 * fix is to plumb sessionId through the subagent_launched payload (separate
 * cli MR, tracked in plan s7 known-limitations list).
 */
/**
 * Minimal AG-UI event consumer for replaying a forgeax `Run`'s `.forgeax/runs/
 * <runId>.jsonl` into a single assistant ChatMessage.  See
 * `packages/server/src/cli-providers/runs/types.ts` for the canonical event
 * shapes — we only handle the cases that drive the UI: TEXT_MESSAGE_CONTENT,
 * TOOL_CALL_START/ARGS/END/RESULT, and the terminal RUN_FINISHED/RUN_ERROR.
 *
 * This is intentionally separate from the forgeax-cli `TurnAccumulator` path
 * (which consumes `StoredEvent` / vag_web format from the agenteam gateway).
 * Subprocess providers (claude-code / codex / cursor-agent) never go through
 * the gateway, so their history can only be reconstructed from this AG-UI
 * stream.
 */
export interface AguiStoredEvent {
  id: string;
  seq: number;
  ts: number;
  runId: string;
  event: { type: string } & Record<string, unknown>;
}

/**
 * Push `chunk` into `segments`, coalescing into the last segment when it
 * matches kind (text↔text, thinking↔thinking).  Tool segments never coalesce.
 *
 * `cloneTextSegments` controls whether a re-rendered React tree should keep
 * referential equality on existing entries — pass `false` for in-place
 * mutation (replay path, single pass), `true` when called from a setState
 * patcher so React sees fresh objects.
 */
export function appendChatSegment(
  segments: ChatSegment[],
  next:
    | { kind: 'text'; ts: number; text: string }
    | { kind: 'thinking'; ts: number; text: string },
): ChatSegment[] {
  if (!next.text) return segments;
  const last = segments[segments.length - 1];
  if (last && last.kind === next.kind) {
    const merged: ChatSegment =
      next.kind === 'text'
        ? { kind: 'text', ts: last.ts, text: (last as { text: string }).text + next.text }
        : { kind: 'thinking', ts: last.ts, text: (last as { text: string }).text + next.text };
    return [...segments.slice(0, -1), merged];
  }
  return [...segments, next];
}

/** Replace an existing tool segment (matched by callId) with a fresh ToolCall,
 *  or append a new tool segment when no match is found. */
export function upsertToolSegment(
  segments: ChatSegment[],
  ts: number,
  next: ToolCall,
): ChatSegment[] {
  const idx = segments.findIndex(
    (s) => s.kind === 'tool' && (s as { tool: ToolCall }).tool.callId === next.callId,
  );
  if (idx >= 0) {
    const updated: ChatSegment = { kind: 'tool', ts: segments[idx].ts, tool: next };
    return [...segments.slice(0, idx), updated, ...segments.slice(idx + 1)];
  }
  return [...segments, { kind: 'tool', ts, tool: next }];
}

function consumeAguiEvents(events: AguiStoredEvent[]): {
  text: string;
  thinking?: string;
  toolCalls: ToolCall[];
  status: 'streaming' | 'done' | 'error';
  /** Time-ordered segments — the canonical render unit. */
  segments: ChatSegment[];
  /** Last seq seen — used as `lastEventId` cursor when resuming an
   *  EventSource so the server only sends events newer than this. */
  lastSeq: number;
} {
  let text = '';
  let thinking = '';
  const tcMap = new Map<string, ToolCall>();
  const order: string[] = [];
  let segments: ChatSegment[] = [];
  let finished = false;
  let errored = false;
  let lastSeq = -1;

  const upsertTc = (id: string, ts: number, next: ToolCall): void => {
    tcMap.set(id, next);
    if (!order.includes(id)) order.push(id);
    segments = upsertToolSegment(segments, ts, next);
  };

  for (const stored of events) {
    if (typeof stored.seq === 'number' && stored.seq > lastSeq) lastSeq = stored.seq;
    const ev = stored.event;
    const ts = stored.ts ?? Date.now();
    switch (ev.type) {
      // ── assistant text (3 spellings: streamed / chunked / legacy) ──
      case 'TEXT_MESSAGE_CONTENT':
      case 'TEXT_MESSAGE_CHUNK': {
        const delta = (ev.delta as string | undefined) ?? (ev.content as string | undefined) ?? '';
        if (delta) {
          text += delta;
          segments = appendChatSegment(segments, { kind: 'text', ts, text: delta });
        }
        break;
      }
      // ── thinking / reasoning ──
      case 'THINKING_TEXT_MESSAGE_CONTENT':
      case 'THINKING_MESSAGE_CONTENT':
      case 'REASONING_MESSAGE_CONTENT':
      case 'REASONING_MESSAGE_CHUNK': {
        const delta = (ev.delta as string | undefined) ?? (ev.content as string | undefined) ?? '';
        if (delta) {
          thinking += delta;
          segments = appendChatSegment(segments, { kind: 'thinking', ts, text: delta });
        }
        break;
      }
      // ── tool calls ──
      case 'TOOL_CALL_START': {
        const id = (ev.toolCallId as string | undefined) ?? '';
        const name = (ev.toolCallName as string | undefined) ?? '';
        if (!id || tcMap.has(id)) break;
        upsertTc(id, ts, { callId: id, name, args: '', status: 'running' });
        break;
      }
      case 'TOOL_CALL_ARGS':
      case 'TOOL_CALL_CHUNK': {
        const id = (ev.toolCallId as string | undefined) ?? '';
        const delta = (ev.delta as string | undefined) ?? '';
        const cur = tcMap.get(id);
        if (cur) {
          const curArgs = typeof cur.args === 'string' ? cur.args : '';
          upsertTc(id, ts, { ...cur, args: curArgs + delta });
        }
        break;
      }
      case 'TOOL_CALL_END': {
        const id = (ev.toolCallId as string | undefined) ?? '';
        const cur = tcMap.get(id);
        if (cur) {
          let parsed: unknown = cur.args;
          if (typeof parsed === 'string' && parsed) {
            try { parsed = JSON.parse(parsed); } catch { /* keep raw string */ }
          }
          upsertTc(id, ts, { ...cur, status: 'done', args: parsed });
        }
        break;
      }
      case 'TOOL_CALL_RESULT': {
        const id = (ev.toolCallId as string | undefined) ?? '';
        const result = (ev.result as unknown) ?? (ev.content as unknown);
        const cur = tcMap.get(id);
        if (cur) {
          upsertTc(id, ts, {
            ...cur,
            status: 'done',
            result: typeof result === 'string' ? result : JSON.stringify(result),
          });
        }
        break;
      }
      // STEP_* markers from sub-agent / phase boundaries — render as tool-style
      // chips so they're visible (Dashboard shows them, ChatPanel used to drop).
      case 'STEP_STARTED': {
        const id = `step:${stored.seq}`;
        upsertTc(id, ts, {
          callId: id,
          name: (ev.stepName as string | undefined) ?? 'step',
          args: ev.input ?? null,
          status: 'running',
        });
        break;
      }
      case 'STEP_FINISHED': {
        const stepName = (ev.stepName as string | undefined) ?? '';
        for (const id of order) {
          const cur = tcMap.get(id);
          if (cur && cur.status === 'running' && cur.name === stepName && id.startsWith('step:')) {
            upsertTc(id, ts, { ...cur, status: 'done' });
            break;
          }
        }
        break;
      }
      case 'RUN_FINISHED': finished = true; break;
      case 'RUN_ERROR':    errored = true;  break;
      default: break;
    }
  }

  const status: 'streaming' | 'done' | 'error' = errored ? 'error' : finished ? 'done' : 'streaming';
  return {
    text,
    thinking: thinking || undefined,
    toolCalls: order.map((id) => tcMap.get(id)!).filter(Boolean),
    status,
    segments,
    lastSeq,
  };
}

/** R3: 后端 fetch_session_events 签名 `args=[sid, agentPath]`。早期 cli 时代
 *  这里只传 agentId 是错的（args[1] agentPath 缺位 → server 抛
 *  "agentPath required" → ok:false → store 拿到空字符串渲染空白），就是当前
 *  "刷新后聊天历史不渲染" 的根因。 */
async function fetchSessionEventsNdjson(sid: string, agentPath: string): Promise<string> {
  try {
    const r = await fetch('/api/commands/fetch_session_events/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: [sid, agentPath] }),
    });
    if (!r.ok) return '';
    const raw = (await r.json()) as {
      ok?: boolean; data?: string;
      result?: { ok?: boolean; data?: string };
    };
    return (raw.result?.data ?? raw.data) ?? '';
  } catch {
    return '';
  }
}

// localStorage key for the persistent cli provider override. Picking 'claude-code'
// should survive a page reload — matches the "pick once, keep using it" feedback.
const PROVIDER_OVERRIDE_KEY = 'forgeax.providerOverride';
function loadProviderOverride(): string | null {
  try {
    const v = localStorage.getItem(PROVIDER_OVERRIDE_KEY);
    return v && v !== 'null' ? v : null;
  } catch {
    return null;
  }
}
function saveProviderOverride(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(PROVIDER_OVERRIDE_KEY);
    else localStorage.setItem(PROVIDER_OVERRIDE_KEY, id);
  } catch { /* ignore (private mode / SSR) */ }
}

// Cross-tab sync: when a sibling tab writes to PROVIDER_OVERRIDE_KEY, push
// the new value into our zustand state so the cli-selector button rerenders
// without a manual reload. Without this, two open tabs drift — tab A shows
// 'auto' even though localStorage already says 'claude-code' (tick 224 hunt).
// The 'storage' event only fires for sibling tabs, not the writer tab; that
// path uses setProviderOverride directly.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== PROVIDER_OVERRIDE_KEY) return;
    const next = e.newValue && e.newValue !== 'null' ? e.newValue : null;
    if (useAppStore.getState().providerOverride !== next) {
      useAppStore.setState({ providerOverride: next });
    }
  });
}

// 用户「卸载」掉的 agent id 列表 —— 首次启动 (INITIALIZED_KEY 缺) 由
// `seedUninstalledIfFirstRun` 把所有 agent 减去 DEFAULT_INSTALLED_AGENT_IDS
// 写进来，之后用户在 Settings → Agents 里勾掉/勾上 都更新这个 list 跟服务端
// 镜像 ~/.forgeax/prefs/uninstalled-agents.json 同步。ChatAgentStrip 渲染时
// 用这个集合做减法过滤；server 端 delegate-tool 同样读这份。
//
// 默认安装五个：forge (main, 不可卸载) + mochi + iori + suzu + rin
//   —— 覆盖 orchestrator + 4 个最常用 sub-persona，剩下的 plugin agent 全部
//   默认卸载，保持 ChatAgentStrip 简洁。用户想要更多，去 Settings → Agents 勾。
//   想换默认 5 个，改这个常量即可（已用过 INITIALIZED_KEY 的老用户不受影响 ——
//   他们的偏好是已生效的本地状态，不会被新默认覆盖）。
export const DEFAULT_INSTALLED_AGENT_IDS = ['forge', 'mochi', 'iori', 'suzu', 'rin'];

const UNINSTALLED_AGENTS_KEY = 'forgeax.uninstalledAgents';
const UNINSTALLED_AGENTS_INITIALIZED_KEY = 'forgeax.uninstalledAgents.initialized';
const DEFAULT_BOOTSTRAP_AGENT_KEY = 'forgeax.defaultBootstrapAgent';
const SETTINGS_SECTION_KEY = 'forgeax.settingsSection';

function loadSettingsSection(): string | null {
  try {
    const v = localStorage.getItem(SETTINGS_SECTION_KEY);
    return v && v.trim() ? v : null;
  } catch { return null; }
}
function saveSettingsSection(id: string | null): void {
  try {
    if (id) localStorage.setItem(SETTINGS_SECTION_KEY, id);
    else localStorage.removeItem(SETTINGS_SECTION_KEY);
  } catch { /* ignore */ }
}

function loadDefaultBootstrapAgent(): string | null {
  try {
    const v = localStorage.getItem(DEFAULT_BOOTSTRAP_AGENT_KEY);
    return v && v.trim() ? v : null;
  } catch { return null; }
}
function saveDefaultBootstrapAgent(id: string | null): void {
  try {
    if (id) localStorage.setItem(DEFAULT_BOOTSTRAP_AGENT_KEY, id);
    else localStorage.removeItem(DEFAULT_BOOTSTRAP_AGENT_KEY);
  } catch { /* ignore */ }
}
function loadUninstalledAgentIds(): string[] {
  try {
    const raw = localStorage.getItem(UNINSTALLED_AGENTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}
function saveUninstalledAgentIds(ids: string[]): void {
  try {
    if (ids.length === 0) localStorage.removeItem(UNINSTALLED_AGENTS_KEY);
    else localStorage.setItem(UNINSTALLED_AGENTS_KEY, JSON.stringify(ids));
  } catch { /* ignore */ }
}
async function pushUninstalledAgentsToServer(ids: string[]): Promise<void> {
  try {
    await fetch('/api/prefs/uninstalled-agents', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
  } catch { /* server prefs are advisory — mirror, never SSOT */ }
}

/** First-run seed: when INITIALIZED_KEY is absent, treat the prefs file as
 *  fresh. Call with the full agent id list (from /api/workbench/agents) ——
 *  uninstall everything that's not in DEFAULT_INSTALLED_AGENT_IDS. Idempotent:
 *  subsequent calls hit the localStorage flag and short-circuit. Skips main
 *  agent (`isMain`) since it's never uninstallable anyway.
 *
 *  Both ChatAgentStrip and AgentsBody fetch /api/workbench/agents; whichever
 *  fires first runs the seed. Setting flag *before* save() prevents a second
 *  caller racing in mid-write.
 */
export function seedUninstalledIfFirstRun(allIds: string[], mainId?: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (localStorage.getItem(UNINSTALLED_AGENTS_INITIALIZED_KEY)) return;
  } catch { return; }
  const installable = new Set(DEFAULT_INSTALLED_AGENT_IDS);
  if (mainId) installable.add(mainId);
  const uninstalled = allIds
    .filter((id) => !installable.has(id))
    .sort();
  try { localStorage.setItem(UNINSTALLED_AGENTS_INITIALIZED_KEY, '1'); } catch { /* ignore */ }
  saveUninstalledAgentIds(uninstalled);
  void pushUninstalledAgentsToServer(uninstalled);
  useAppStore.setState({ uninstalledAgentIds: uninstalled });
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== UNINSTALLED_AGENTS_KEY) return;
    const next = loadUninstalledAgentIds();
    const cur = useAppStore.getState().uninstalledAgentIds;
    if (cur.length !== next.length || cur.some((id, i) => id !== next[i])) {
      useAppStore.setState({ uninstalledAgentIds: next });
    }
  });
}

// In-flight SSE AbortController for cancelStream(). Module-level so the
// store can reach it without storing a non-serializable object in zustand state.
//
// per-session abort controllers keyed by sid (R3 后 tab 跟 sid 一一对应，原来
// 的"tabId"参数在所有内部 helper 里语义都是 sid)。cancelStream aborts the
// *active* tab's controller. Switching tabs mid-stream doesn't cancel the
// background stream — its handlers continue patching the *tab*'s archived
// messages list (not the top-level mirror) until terminal.
const _abortByTab = new Map<string, AbortController>();

// EventSource tails opened by loadThreadHistory for runs still streaming on
// server.  Keyed by sid so closing a session (or cancelling its current run)
// tears down all attached tails.
const _tailsByTab = new Map<string, Set<EventSource>>();
function trackTail(sid: string, es: EventSource): void {
  let set = _tailsByTab.get(sid);
  if (!set) { set = new Set(); _tailsByTab.set(sid, set); }
  set.add(es);
}
function untrackTail(sid: string, es: EventSource): void {
  const set = _tailsByTab.get(sid);
  if (!set) return;
  set.delete(es);
  if (set.size === 0) _tailsByTab.delete(sid);
}
function closeThreadHistoryTails(sid: string): void {
  const set = _tailsByTab.get(sid);
  if (!set) return;
  for (const es of set) {
    try { es.close(); } catch { /* */ }
  }
  _tailsByTab.delete(sid);
}

// P-UNIFY.4: per-tickId pending bubble lookup. Server broadcasts WS events
// `daemon-tick-start` / `daemon-tick-event` / `daemon-tick-end` with a unique
// tickId; the start event spawns a new assistant ChatMessage, subsequent
// events stream into it, end terminalises status. Lookup is by tickId →
// msgId so we can mutate the right bubble across multiple delivered events.
const _tickMsgIdByTickId = new Map<string, string>();

/** 内存泄漏 case-12 测量缝(test seam)—— 模块私有 `_tickMsgIdByTickId` 的当前条目数。
 *  store 状态(window.__dev)看不到这个模块级 Map,forgeax-mem-e2e 的 repro 靠它精确
 *  量测「关 session 后残留的孤儿 daemon-tick 条目」(与 case-10 的
 *  `_fileActivityStreamSessionCount` 同型的只读缝)。 */
export function _daemonTickMapCount(): number {
  return _tickMsgIdByTickId.size;
}

// Single global WS connection for daemon tick stream. Mounted lazily on first
// store creation. Reconnects with exponential backoff.
let _wsForDaemons: WebSocket | null = null;
let _wsRetryMs = 1000;
function connectDaemonWs(onMessage: (msg: unknown) => void): void {
  if (typeof window === 'undefined') return;
  if (_wsForDaemons && _wsForDaemons.readyState !== WebSocket.CLOSED) return;
  try {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
    _wsForDaemons = ws;
    ws.onopen = () => {
      _wsRetryMs = 1000;
    };
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(typeof e.data === 'string' ? e.data : ''));
      } catch { /* ignore */ }
    };
    ws.onclose = () => {
      _wsForDaemons = null;
      setTimeout(() => connectDaemonWs(onMessage), _wsRetryMs);
      _wsRetryMs = Math.min(_wsRetryMs * 2, 30000);
    };
    ws.onerror = () => {
      try { ws.close(); } catch { /* ignore */ }
    };
  } catch {
    setTimeout(() => connectDaemonWs(onMessage), _wsRetryMs);
  }
}

// ── Sessions persistence ───────────────────────────────────────────────────
// 2026-05-20 重做：不再持久化 tabs 数组本身（tabs = GET /api/sessions 派生）。
// 只持久化 activeSid（用户上次看的是哪条），boot 时再 init。同时一次性清掉
// 老 key (forgeax.tabs / forgeax.activeTabId) 防止旧数据残留。
const ACTIVE_SID_KEY = 'forgeax.activeSid';
const AGENT_BY_SID_KEY = 'forgeax.agentBySid';
// 老 keys —— 启动时一次性 cleanup 清掉，老用户回来不会带着无效"幽灵 tab" 启动。
const LEGACY_TABS_KEY = 'forgeax.tabs';
const LEGACY_ACTIVE_TAB_KEY = 'forgeax.activeTabId';

(function cleanupLegacyKeys(): void {
  try {
    localStorage.removeItem(LEGACY_TABS_KEY);
    localStorage.removeItem(LEGACY_ACTIVE_TAB_KEY);
  } catch { /* ignore (private mode / SSR) */ }
})();

/** Persisted per-sid agent cache —— ref ink-renderer `agentByInstance` 移植。
 *  对外只暴露 read / write 两个动作；boot 时一次性 load 当 init state，runtime
 *  写盘交给 `setTabAgent` 的副作用。 */
function loadAgentBySid(): Record<string, string> {
  try {
    const raw = localStorage.getItem(AGENT_BY_SID_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const out: Record<string, string> = {};
    for (const [sid, agent] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof sid === 'string' && typeof agent === 'string' && sid && agent) {
        out[sid] = agent;
      }
    }
    return out;
  } catch {
    return {};
  }
}
function persistAgentBySid(map: Record<string, string>): void {
  try { localStorage.setItem(AGENT_BY_SID_KEY, JSON.stringify(map)); }
  catch { /* ignore */ }
}

function loadActiveSid(): string | null {
  try {
    const v = localStorage.getItem(ACTIVE_SID_KEY);
    return v && v.trim() ? v : null;
  } catch { return null; }
}
function persistActiveSid(sid: string | null): void {
  try {
    if (sid) localStorage.setItem(ACTIVE_SID_KEY, sid);
    else localStorage.removeItem(ACTIVE_SID_KEY);
  } catch { /* ignore */ }
}

/** Patch the messages of a specific tab (key = sid), targeting the *active
 *  agent's slot* (i.e. tab.agentId). Updates both `messagesByAgent[agentId]`
 *  and the top-level `tab.messages` mirror in lockstep. When the patched
 *  tab is active, also bumps the store's top-level `messages` mirror.
 *
 *  Pre-multiplex callers (sendMessage user/asst pre-push, system errors,
 *  /tool result) still want this — they target whoever the user currently
 *  sees, which is the active agent. WS-driven writers go through
 *  `patchAgentMessages(sid, agentId, …)` below to target a non-active slot. */
function patchTabMessages(
  state: AppState,
  sid: string,
  updater: (msgs: ChatMessage[]) => ChatMessage[],
): Partial<AppState> {
  const tabs = state.tabs.map((t) => {
    if (t.sid !== sid) return t;
    const next = updater(t.messages);
    const aid = t.agentId;
    return aid
      ? { ...t, messages: next, messagesByAgent: { ...t.messagesByAgent, [aid]: next } }
      : { ...t, messages: next };
  });
  if (state.activeSid === sid) {
    const tab = tabs.find((t) => t.sid === sid);
    return { tabs, messages: tab?.messages ?? [] };
  }
  return { tabs };
}

/** Patch a specific agent's slot inside `tab.messagesByAgent[agentId]`.
 *  When that agent is also the active pin (`tab.agentId === agentId`),
 *  mirrors the result into `tab.messages` and the top-level `messages`
 *  selector so the visible chat thread updates. Otherwise the slot updates
 *  silently in the background — switching to that agent later restores it.
 *  Used by session-stream WS dispatch where each event carries an
 *  emitterId that may not match the active pin (Forge delegating to
 *  mochi while user views mochi's tab). */
export function patchAgentMessages(
  state: AppState,
  sid: string,
  agentId: string,
  updater: (msgs: ChatMessage[]) => ChatMessage[],
): Partial<AppState> {
  const tabs = state.tabs.map((t) => {
    if (t.sid !== sid) return t;
    const prev = t.messagesByAgent[agentId] ?? (t.agentId === agentId ? t.messages : []);
    const next = updater(prev);
    const messagesByAgent = { ...t.messagesByAgent, [agentId]: next };
    if (t.agentId === agentId) {
      return { ...t, messagesByAgent, messages: next };
    }
    return { ...t, messagesByAgent };
  });
  if (state.activeSid === sid) {
    const tab = tabs.find((t) => t.sid === sid);
    if (tab && tab.agentId === agentId) return { tabs, messages: tab.messages };
  }
  return { tabs };
}

/** Read a specific (sid, agentId)'s messages from the store, falling back to
 *  tab.messages when the per-agent slot is empty AND that agent is the active
 *  pin (handles legacy code that pushed straight to tab.messages without
 *  syncing the per-agent map yet). */
export function readAgentMessages(state: AppState, sid: string, agentId: string): ChatMessage[] {
  const tab = state.tabs.find((t) => t.sid === sid);
  if (!tab) return [];
  const slot = tab.messagesByAgent[agentId];
  if (slot) return slot;
  return tab.agentId === agentId ? tab.messages : [];
}

/** Patch a tab's per-tab field. Also mirrors to top-level when active.
 *  When `isStreaming` is patched, also propagate to streamingByAgent[t.agentId]
 *  so the per-agent flag stays in lockstep with the active mirror — without
 *  this, a turnEnd would clear `isStreaming` but leave the per-agent slot
 *  dirty, and switching back to the agent later would resurrect the spinner. */
function patchTabField(
  state: AppState,
  sid: string,
  patch: Partial<Pick<ChatTab,
    'runId' | 'providerOverride' | 'displayName' | 'isStreaming'
    | 'pendingRewind' | 'checkpointMsgIds' | 'rewindDirtyNotice'>>,
): Partial<AppState> {
  const tabs = state.tabs.map((t) => {
    if (t.sid !== sid) return t;
    const next: ChatTab = { ...t, ...patch };
    if (patch.isStreaming !== undefined && t.agentId) {
      next.streamingByAgent = { ...t.streamingByAgent, [t.agentId]: patch.isStreaming };
    }
    return next;
  });
  const out: Partial<AppState> = { tabs };
  if (state.activeSid === sid) {
    if (patch.providerOverride !== undefined) out.providerOverride = patch.providerOverride;
    if (patch.isStreaming !== undefined) out.isStreaming = patch.isStreaming;
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
    const { listSessionAgents } = await import('./lib/forgeax-bridge');
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
    const tab = useAppStore.getState().tabs.find((t) => t.sid === sid);
    const cached = tab?.agentId ?? null;
    const cachedInTree = cached ? agents.some((a) => a.path === cached) : false;
    const wantPath = cached ? cached : root;
    const target = agents.find((a) => a.path === wantPath);
    // Marketplace pin not yet observed in tree (cached but not in agents):
    // wantPath === cached but `target` is undefined. We still want to keep
    // the pin and show running:false until the auto-scaffold lands. No
    // tab.messagesByAgent rewiring needed since the pin is unchanged.
    const targetRunning = target?.running ?? false;
    useAppStore.setState((s) => {
      // Only update agentBySid when we're filling a previously-empty slot.
      // Keeping a marketplace pin: cached !== null already => leave as-is.
      const agentBySid = cached ? s.agentBySid : { ...s.agentBySid, [sid]: wantPath };
      const tabs = s.tabs.map((t) => {
        if (t.sid !== sid) return t;
        // Snapshot leaving agent's view (mirror of setTabAgent — boot-time
        // path doesn't go through the action, but the same slot-swap logic
        // applies whenever agentId changes). Without this, switching agents
        // pre-boot leaks messages from the previous slot.
        const oldId = t.agentId;
        const messagesByAgent = { ...t.messagesByAgent };
        const streamingByAgent = { ...t.streamingByAgent };
        if (oldId && oldId !== wantPath) {
          messagesByAgent[oldId] = t.messages;
          streamingByAgent[oldId] = t.isStreaming;
        }
        streamingByAgent[wantPath] = targetRunning;
        const restored = messagesByAgent[wantPath] ?? (oldId === wantPath ? t.messages : []);
        return {
          ...t,
          agentId: wantPath,
          isStreaming: targetRunning,
          messages: restored,
          messagesByAgent,
          streamingByAgent,
        };
      });
      const out: Partial<typeof s> = { tabs, agentBySid };
      if (s.activeSid === sid) {
        const active = tabs.find((t) => t.sid === sid);
        if (active) {
          out.isStreaming = active.isStreaming;
          out.messages = active.messages;
        }
      }
      return out;
    });
    if (!cached) persistAgentBySid(useAppStore.getState().agentBySid);
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
  messages: [] as ChatMessage[],
  isStreaming: false,
  queuedMessages: {},
  currentSessionId: _initialActiveSid,
  providerOverride: loadProviderOverride(),
  uninstalledAgentIds: loadUninstalledAgentIds(),
  defaultBootstrapAgent: loadDefaultBootstrapAgent(),
};

// P-UNIFY.4 — daemon WS handler. Hoisted out of the store factory so it
// captures set/get via closure after they're available. Routes daemon-tick-*
// events to the right tab by threadId, with bubble keyed by tickId.
export function handleDaemonWs(msg: unknown): void {
  if (!msg || typeof msg !== 'object') return;
  const m = msg as { type?: string; threadId?: string; tickId?: string; daemonId?: string; event?: unknown; promptPreview?: string; bytes?: number; records?: unknown };
  // Telemetry (trace+log) main信道: node sidecar → server → WS
  // `{ type:'telemetry', records: Array<SpanData|LogRecord> }`. No threadId, so
  // it must be dispatched before the threadId guard below (same as
  // workspace-changed). Feeds the unified telemetry slice (500-cap, S4).
  if (m.type === 'telemetry') {
    const records = Array.isArray(m.records) ? (m.records as TelemetryRecord[]) : [];
    if (records.length) useAppStore.getState().pushTelemetry(records);
    return;
  }
  // Workspace hot-switch: the server re-pointed FORGEAX_PROJECT_ROOT at a new
  // dir. In-process and in-tab state scoped to the old root isn't re-scoped, so
  // every open tab must do a full reload (all per-request endpoints then re-read
  // the new root). This broadcast carries no threadId, so it must be handled
  // before the threadId guard below. Guard against reload loops: only reload
  // when the broadcast actually names a different active root than this tab's.
  if (m.type === 'workspace-changed') {
    try {
      const next = (m as { absPath?: string }).absPath ?? '';
      const prev = sessionStorage.getItem('forgeax.activeRoot') ?? '';
      if (next && next === prev) return;
      if (next) sessionStorage.setItem('forgeax.activeRoot', next);
      window.location.reload();
    } catch { /* non-browser ctx */ }
    return;
  }
  if (!m.threadId || !m.tickId) return;
  const state = useAppStore.getState();
  // R3 后 threadId === sid（一一对应），daemon 的 sourceThreadId 当 sid 用即可。
  const tab = state.tabs.find((t) => t.sid === m.threadId);
  if (!tab) return;
  // 内存泄漏 case-12 (MEMLEAK_CASE12_DAEMON_TICK_KEY): _tickMsgIdByTickId 原来按裸
  // tickId 累积,只在 daemon-tick-end 删。但上方 `if (!tab) return` 守卫会把已关
  // session 的 tick-end 丢弃 → 关 session 时在飞的 tick 收不到 end,条目永久滞留这个
  // 模块级 Map(closeSession 摘 liveAgents/file-activity-stream 却不碰它)。改用
  // `${sid}::${tickId}` 复合键,让 closeSession 能按 sid 前缀整批摘除(同 queuedMessages
  // case-07 的复合键)。值仍是裸 tickId 衍生的 bubble id,渲染不变。
  const tickKey = `${m.threadId}::${m.tickId}`;
  if (m.type === 'daemon-tick-start') {
    const existing = _tickMsgIdByTickId.get(tickKey);
    if (existing) return;
    const newId = `daemon-tick-${m.tickId}`;
    _tickMsgIdByTickId.set(tickKey, newId);
    const bubble: ChatMessage = {
      id: newId,
      role: 'assistant',
      text: m.promptPreview ? `🔁 daemon \`${m.daemonId}\` tick\n\n> ${m.promptPreview}\n\n---\n\n` : `🔁 daemon \`${m.daemonId}\` tick\n\n`,
      toolCalls: [],
      status: 'streaming',
      ts: Date.now(),
      providerId: 'daemon',
    };
    useAppStore.setState((s) => patchTabMessages(s, tab.sid, (msgs) => [...msgs, bubble]));
    return;
  }
  if (m.type === 'daemon-tick-event' && m.event) {
    const msgId = _tickMsgIdByTickId.get(tickKey);
    if (!msgId) return;
    const ev = m.event as { type: string; text?: string; message?: string; name?: string; args?: unknown; result?: unknown };
    let appendText = '';
    if (ev.type === 'token' && ev.text) appendText = ev.text;
    else if (ev.type === 'thinking' && ev.text) appendText = ''; // skip thinking in chat panel
    else if (ev.type === 'tool-call') appendText = `\n\n\`[tool-call] ${ev.name ?? '?'}\``;
    else if (ev.type === 'tool-result') {
      const r = ev.result;
      const text = typeof r === 'string' ? r : JSON.stringify(r ?? '');
      appendText = `\n\n\`[tool-result]\` ${text.slice(0, 400)}`;
    } else if (ev.type === 'error') appendText = `\n\n❌ \`[error]\` ${ev.message ?? ''}`;
    if (!appendText) return;
    useAppStore.setState((s) =>
      patchTabMessages(s, tab.sid, (msgs) =>
        msgs.map((mm) => (mm.id === msgId ? { ...mm, text: mm.text + appendText } : mm)),
      ),
    );
    return;
  }
  if (m.type === 'daemon-tick-end') {
    const msgId = _tickMsgIdByTickId.get(tickKey);
    if (!msgId) return;
    _tickMsgIdByTickId.delete(tickKey);
    useAppStore.setState((s) =>
      patchTabMessages(s, tab.sid, (msgs) =>
        msgs.map((mm) =>
          mm.id === msgId
            ? { ...mm, status: 'done', text: mm.text + `\n\n_— tick done · ${m.bytes ?? 0} bytes —_` }
            : mm,
        ),
      ),
    );
  }
}

// Connect WS on module load. HMR-safe via globalThis flag so re-evaluated
// modules don't skip the connect or spawn duplicates.
const _DAEMON_WS_FLAG = '__FORGEAX_DAEMON_WS_BOUND__';
type WithFlag = { [_DAEMON_WS_FLAG]?: { handler: typeof handleDaemonWs } };
const _gt = globalThis as unknown as WithFlag;
if (typeof window !== 'undefined') {
  if (_gt[_DAEMON_WS_FLAG]) {
    // Update the live handler so HMR-refreshed code runs without
    // dropping the open socket connection.
    _gt[_DAEMON_WS_FLAG].handler = handleDaemonWs;
  } else {
    _gt[_DAEMON_WS_FLAG] = { handler: handleDaemonWs };
    connectDaemonWs((msg) => _gt[_DAEMON_WS_FLAG]!.handler(msg));
  }
}

// memleak case-03 (MEMLEAK_CASE03_STORE_CAP) — store-side chat-history window.
// case-02 windowed the *DOM* to 120 rendered blocks, but `messagesByAgent` /
// `messages` / `segments` were still retained for EVERY message forever — a
// marathon session grew the JS heap monotonically (≈tool-result bytes per turn,
// never released even after GC; measured +63MB over 720 turns with 80KB
// payloads, tail slope 0.077 MB/msg). The DOM window hid the symptom; the store
// kept leaking.
//
// Fix: enforce a max-slot invariant at the *setState chokepoint*. We bound every
// per-agent slot (and the active `messages` mirror) to the most recent N
// messages. Done as a tiny zustand middleware that wraps both the internal
// `set` AND `api.setState`, so it covers internal actions, the patch helpers
// (patchTabMessages / patchAgentMessages), every direct `messagesByAgent[…] =`
// writer, AND raw external `useAppStore.setState`. case-02's "load earlier" still
// pages back through the store — now bounded to this window instead of unbounded.
const MEMLEAK_CASE03_STORE_CAP = 300;

// case-09 — checkpointMsgIds registers a key per user turn (keyed by server
// msgId) but capChatSlots drops the message at 300 without dropping its checkpoint
// key, so the map grows unbounded while messages stay flat. Prune to msgIds that
// still back a live message; only called when a tab's messages were just capped.
function pruneCheckpointMsgIds(tab: ChatTab): ChatTab {
  const ck = tab.checkpointMsgIds;
  if (!ck || Object.keys(ck).length === 0) return tab;
  const live = new Set<string>();
  for (const m of tab.messages ?? []) if (m.msgId) live.add(m.msgId);
  if (tab.messagesByAgent) {
    for (const arr of Object.values(tab.messagesByAgent)) {
      for (const m of arr) if (m?.msgId) live.add(m.msgId);
    }
  }
  let changed = false;
  const pruned: Record<string, boolean> = {};
  for (const k of Object.keys(ck)) {
    if (live.has(k)) pruned[k] = ck[k];
    else changed = true;
  }
  return changed ? { ...tab, checkpointMsgIds: pruned } : tab;
}

// case-11 — streamingByAgent gets a key per sub-agent emitterId that ever streamed
// (session-stream routes hook:turnStart/turnEnd by emitterId). A finished NON-active
// agent leaves a dead `false` flag that is never removed, so a session delegating to
// many sub-agents accumulates them without bound. Every reader coerces a missing key
// to false (Boolean(...)/!!...; the one Object.entries loop in ChatAgentCapsule only
// acts on `true`), so dropping non-active false flags is behaviour-neutral. The
// active agent's flag is kept to preserve the isStreaming↔streamingByAgent[agentId]
// invariant.
function pruneStreamingFlags(tab: ChatTab): ChatTab {
  const sba = tab.streamingByAgent;
  if (!sba) return tab;
  let hasDead = false;
  for (const k of Object.keys(sba)) {
    if (sba[k] === false && k !== tab.agentId) { hasDead = true; break; }
  }
  if (!hasDead) return tab;
  const pruned: Record<string, boolean> = {};
  for (const k of Object.keys(sba)) {
    if (sba[k] === false && k !== tab.agentId) continue;
    pruned[k] = sba[k];
  }
  return { ...tab, streamingByAgent: pruned };
}

function capChatSlots(partial: Partial<AppState>): Partial<AppState> {
  if (!partial || typeof partial !== 'object') return partial;
  const CAP = MEMLEAK_CASE03_STORE_CAP;
  let out = partial;
  // top-level active mirror
  const topMsgs = partial.messages;
  if (Array.isArray(topMsgs) && topMsgs.length > CAP) {
    out = { ...out, messages: topMsgs.slice(topMsgs.length - CAP) };
  }
  // per-tab slots + per-tab mirror
  if (Array.isArray(partial.tabs)) {
    let tabsChanged = false;
    const tabs = partial.tabs.map((t) => {
      let nt = t;
      if (Array.isArray(t.messages) && t.messages.length > CAP) {
        nt = { ...nt, messages: t.messages.slice(t.messages.length - CAP) };
      }
      if (t.messagesByAgent) {
        let mba = t.messagesByAgent;
        let mbaChanged = false;
        for (const k of Object.keys(t.messagesByAgent)) {
          const slot = t.messagesByAgent[k];
          if (Array.isArray(slot) && slot.length > CAP) {
            if (!mbaChanged) {
              mba = { ...t.messagesByAgent };
              mbaChanged = true;
            }
            mba[k] = slot.slice(slot.length - CAP);
          }
        }
        if (mbaChanged) nt = { ...nt, messagesByAgent: mba };
      }
      if (nt !== t) nt = pruneCheckpointMsgIds(nt); // case-09 — prune on cap
      nt = pruneStreamingFlags(nt);                 // case-11 — drop dead non-active streaming flags
      if (nt !== t) tabsChanged = true;
      return nt;
    });
    if (tabsChanged) out = { ...out, tabs };
  }
  return out;
}

// Wrap set/setState so the cap invariant holds no matter who writes. Returns the
// partial unchanged when nothing exceeds the cap (no extra allocations/renders).
const capStoreMiddleware =
  (config: StateCreator<AppState>): StateCreator<AppState> =>
  (set, get, api) => {
    const cappedSet: typeof set = ((partial: unknown, replace?: boolean) => {
      const next =
        typeof partial === 'function'
          ? (partial as (s: AppState) => AppState | Partial<AppState>)(get())
          : (partial as Partial<AppState>);
      return (set as unknown as (p: unknown, r?: boolean) => void)(capChatSlots(next), replace);
    }) as typeof set;
    api.setState = cappedSet;
    return config(cappedSet, get, api);
  };

export const useAppStore = create<AppState>(capStoreMiddleware((set, get) => ({
  // 启动 mode 跟随持久化的活动工作区（Play/Edit/AI），避免刷新后 tab 高亮与主区域
  // 内容错位（见 lib/workspaces.ts bootAppMode 注释）。
  mode: bootAppMode(),
  setMode: (m) => set({ mode: m }),
  workbenchTab: 'agents',
  setWorkbenchTab: (t) => set({ workbenchTab: t }),
  workbenchExpandedPluginId: null,
  setWorkbenchExpandedPluginId: (id) => set({ workbenchExpandedPluginId: id }),
  openWorkbench: ({ tab, expandedPluginId }) => set((s) => ({
    mode: 'workbench',
    workbenchTab: tab ?? s.workbenchTab,
    // `undefined` = leave center untouched (e.g. pure tab nav); explicit null
    // clears it; a string expands that plugin. Open paths always pass it.
    workbenchExpandedPluginId: expandedPluginId !== undefined ? expandedPluginId : s.workbenchExpandedPluginId,
  })),

  dockedPlugins: new Set<string>(),
  addDockedPlugin: (id) => set((s) => ({ dockedPlugins: new Set([...s.dockedPlugins, id]) })),
  removeDockedPlugin: (id) => set((s) => { const next = new Set(s.dockedPlugins); next.delete(id); return { dockedPlugins: next }; }),

  floatingSurfaces: {},
  detachSurface: async (d, opts) => {
    const wm = getWindowManager();
    if (!wm.canDetach()) return; // browser form — no-op
    const key = surfaceKey(d);
    // Optimistically mark floating so the main window tears down its keep-alive
    // iframe BEFORE the new window boots — avoids a transient double instance.
    set((s) => ({ floatingSurfaces: { ...s.floatingSurfaces, [key]: true } }));
    const ok = await wm.openSurfaceWindow(d, { title: opts?.title });
    if (!ok) {
      // Window failed to open — revert so the surface stays docked & visible.
      set((s) => {
        const next = { ...s.floatingSurfaces };
        delete next[key];
        return { floatingSurfaces: next };
      });
    }
  },
  redockSurface: async (d) => {
    const wm = getWindowManager();
    await wm.closeSurfaceWindow(d);
    get().markSurfaceDocked(surfaceKey(d));
  },
  markSurfaceDocked: (key) =>
    set((s) => {
      if (!s.floatingSurfaces[key]) return {} as Partial<typeof s>;
      const next = { ...s.floatingSurfaces };
      delete next[key];
      return { floatingSurfaces: next };
    }),
  pendingBusExpandId: null,
  setPendingBusExpandId: (id) => set({ pendingBusExpandId: id }),

  composerPendingInsert: null,
  composerPendingInsertQueue: [],
  requestComposerInsert: (p) => set((s) => ({
    composerPendingInsertQueue: [...s.composerPendingInsertQueue, p],
    composerPendingInsert: s.composerPendingInsertQueue.length === 0 ? p : s.composerPendingInsert,
  })),
  clearComposerPendingInsert: () => set((s) => {
    const q = s.composerPendingInsertQueue.slice(1);
    return { composerPendingInsertQueue: q, composerPendingInsert: q[0] ?? null };
  }),

  // ── checkpoint 回退点 ──
  composerPendingText: null,
  requestComposerText: (text) => set({ composerPendingText: text }),
  clearComposerPendingText: () => set({ composerPendingText: null }),

  loadCheckpoints: async (sid) => {
    if (!sid) return;
    try {
      const { fetchCheckpoints } = await import('./lib/checkpoint-api');
      const { checkpoints, pending } = await fetchCheckpoints(sid);
      const checkpointMsgIds: Record<string, boolean> = {};
      for (const c of checkpoints) checkpointMsgIds[c.msgId] = c.hasCode;
      set((s) => {
        return patchTabField(s, sid, {
          checkpointMsgIds,
          pendingRewind: pending
            ? {
                boundaryId: pending.boundaryId,
                targetMsgId: pending.targetMsgId,
                mode: pending.mode,
                keptDirty: pending.keptDirty,
                overwrite: pending.overwrite ? { files: pending.overwrite.files } : null,
              }
            : null,
        });
      });
    } catch (e) {
      console.warn('[checkpoint] loadCheckpoints failed', (e as Error).message);
    }
  },

  performRewind: async (sid, msgId, mode) => {
    const { rewindTo } = await import('./lib/checkpoint-api');
    await rewindTo(sid, msgId, mode); // 状态由 rewind:done WS 事件落
  },
  performRewindCancel: async (sid) => {
    const boundaryId = get().tabs.find((t) => t.sid === sid)?.pendingRewind?.boundaryId;
    if (!boundaryId) {
      // 本地没有挂起态却被点了 —— 直接幂等清干净,避免编辑框卡住。
      set((s) => patchTabField(s, sid, { pendingRewind: null }));
      return;
    }
    const { rewindCancel } = await import('./lib/checkpoint-api');
    try {
      await rewindCancel(sid, boundaryId);
      // 正常路径状态由 rewind:cancelled WS 事件落;这里不抢更新。
    } catch (e) {
      // 409 = 服务端已不是 pending(已定格/已恢复)。本地仍显示编辑框就是脏
      // 状态,主动清掉 pendingRewind 让编辑框消失 —— 比卡在编辑态好。
      const msg = (e as Error)?.message ?? '';
      if (/\b409\b/.test(msg) || /not pending|finalized|cancelled/i.test(msg)) {
        set((s) => patchTabField(s, sid, { pendingRewind: null }));
        void get().loadCheckpoints(sid); // 与服务端真相重新对齐
        return;
      }
      throw e; // 网络等真错误 → 抛给调用方提示
    }
  },
  performOverwriteDirty: async (sid) => {
    const t = get().tabs.find((x) => x.sid === sid);
    const boundaryId = t?.rewindDirtyNotice?.boundaryId ?? t?.pendingRewind?.boundaryId;
    if (!boundaryId) return;
    const { rewindOverwriteDirty } = await import('./lib/checkpoint-api');
    await rewindOverwriteDirty(sid, boundaryId);
  },
  performUndoOverwrite: async (sid) => {
    const t = get().tabs.find((x) => x.sid === sid);
    const boundaryId = t?.rewindDirtyNotice?.boundaryId ?? t?.pendingRewind?.boundaryId;
    if (!boundaryId) return;
    const { rewindUndoOverwrite } = await import('./lib/checkpoint-api');
    await rewindUndoOverwrite(sid, boundaryId);
  },

  applyRewindEvent: (sid, kind, payload) => {
    const tab = get().tabs.find((t) => t.sid === sid);
    if (!tab) return;
    if (kind === 'done') {
      const msgId = String(payload.msgId ?? '');
      // 迟到 / 已定格的 done:目标消息已被 finalized 从列表删除则忽略 —— 否则会用一个
      // 不存在的 targetMsgId 重新置灰并弹出假「已回退」条。done(/rewind 的 WS)与
      // finalized(/messages 的 WS)跨双通道,编辑后回退发送时 done 可能后到。正常 ⟲
      // 回退时目标消息仍在列表 → 不命中本守卫。
      if (msgId && tab.agentId) {
        const cur = tab.messagesByAgent[tab.agentId];
        if (Array.isArray(cur) && cur.length > 0 && !cur.some((m) => m.msgId === msgId)) return;
      }
      const mode = (payload.mode === 'code' || payload.mode === 'conversation' ? payload.mode : 'both') as
        'both' | 'conversation' | 'code';
      const boundaryId = String(payload.boundaryId ?? '');
      const keptDirty = Array.isArray(payload.keptDirty) ? (payload.keptDirty as string[]) : [];
      set((s) => patchTabField(s, sid, {
        pendingRewind: {
          boundaryId,
          targetMsgId: msgId,
          mode,
          keptDirty,
          overwrite: null,
        },
        rewindDirtyNotice: keptDirty.length > 0 ? { boundaryId, keptDirty, overwrite: null } : null,
      }));
      // 会话回退后,目标消息原地变成内联编辑框(Cursor 风格),文本由
      // ChatPanel 的 RewindInlineEditor 直接读目标消息 —— 不再回填底部 Composer。
    } else if (kind === 'cancelled') {
      // 恢复(Redo):挂起态清空;cancel 时保留的脏文件通知独立存续
      // (核心场景:恢复后仍可「这些文件也回退」)。
      const boundaryId = String(payload.boundaryId ?? '');
      const keptDirty = Array.isArray(payload.keptDirty) ? (payload.keptDirty as string[]) : [];
      set((s) => patchTabField(s, sid, {
        pendingRewind: null,
        rewindDirtyNotice: keptDirty.length > 0 ? { boundaryId, keptDirty, overwrite: null } : null,
      }));
      get().clearComposerPendingText();
    } else if (kind === 'finalized') {
      // 定格:把被回退段从消息列表移除。**刷新安全**——不依赖回退时
      // 冻结的 rewoundIds(刷新后可能为空),而是在定格这一刻按当前列表现算:
      // 被回退段 = [目标消息下标 .. 最后一条 user 消息之前],「最后一条 user」
      // 就是刚发出的那条新消息;它及其后(新回复)保留。WAL 里仍在,mask 后
      // 不可见,刷新 replay 结果一致。
      //
      // target/mode **优先取事件自带**(server 在 finalizePending 回带),仅当事件没带
      // 时才回退到本地 pendingRewind。关键:done 与 finalized 跨 WS 双通道,编辑后回退
      // 发送时 finalized 可能先于 done 到达,此刻 pendingRewind 仍为 null —— 若只认
      // pendingRewind 就会漏删置灰段(且 editingMsgId 因 pendingRewind 没转真也不清),
      // 表现为「灰色段不删、新消息也灰」。
      const pr = tab.pendingRewind;
      const targetMsgId = String(payload.targetMsgId ?? pr?.targetMsgId ?? '');
      const pm = payload.mode;
      const finMode: 'both' | 'conversation' | 'code' =
        pm === 'code' || pm === 'conversation' || pm === 'both' ? pm : (pr?.mode ?? 'both');
      set((s) => patchTabField(s, sid, { pendingRewind: null, rewindDirtyNotice: null }));
      if (targetMsgId && finMode !== 'code' && tab.agentId) {
        const agent = tab.agentId;
        set((s) => patchAgentMessages(s, sid, agent, (msgs) => {
          const targetIdx = msgs.findIndex((m) => m.msgId === targetMsgId);
          if (targetIdx < 0) return msgs;
          let lastUserIdx = -1;
          for (let i = msgs.length - 1; i > targetIdx; i--) {
            if (msgs[i].role === 'user') { lastUserIdx = i; break; }
          }
          // 没有更靠后的新 user 消息(理论上定格必由新消息触发);兜底全砍到尾
          const cutEnd = lastUserIdx > targetIdx ? lastUserIdx : msgs.length;
          return [...msgs.slice(0, targetIdx), ...msgs.slice(cutEnd)];
        }));
      }
    } else if (kind === 'overwrite') {
      const files = Array.isArray(payload.files) ? (payload.files as string[]) : [];
      const boundaryId = String(payload.boundaryId ?? '');
      set((s) => {
        const t = s.tabs.find((x) => x.sid === sid);
        if (!t) return {};
        return patchTabField(s, sid, {
          rewindDirtyNotice: { boundaryId, keptDirty: [], overwrite: { files } },
          ...(t.pendingRewind
            ? { pendingRewind: { ...t.pendingRewind, keptDirty: [], overwrite: { files } } }
            : {}),
        });
      });
    } else if (kind === 'overwrite-undone') {
      const files = Array.isArray(payload.files) ? (payload.files as string[]) : [];
      const boundaryId = String(payload.boundaryId ?? '');
      set((s) => {
        const t = s.tabs.find((x) => x.sid === sid);
        if (!t) return {};
        return patchTabField(s, sid, {
          rewindDirtyNotice: { boundaryId, keptDirty: files, overwrite: null },
          ...(t.pendingRewind
            ? { pendingRewind: { ...t.pendingRewind, keptDirty: files, overwrite: null } }
            : {}),
        });
      });
    }
  },

  pendingSidebarFocusPluginId: null,
  setPendingSidebarFocusPluginId: (id) => set({ pendingSidebarFocusPluginId: id }),
  pendingBusKindFilter: null,
  setPendingBusKindFilter: (kind) => set({ pendingBusKindFilter: kind }),
  pendingSidebarKindFlash: null,
  setPendingSidebarKindFlash: (kind) => set({ pendingSidebarKindFlash: kind }),
  pendingChatPanelBusFlash: null,
  setPendingChatPanelBusFlash: (id) => set({ pendingChatPanelBusFlash: id }),
  pendingRunsDateFilter: null,
  setPendingRunsDateFilter: (f) => set({ pendingRunsDateFilter: f }),
  activeSession: 'main-design',
  setActiveSession: (s) => set({ activeSession: s }),
  setTabAgent: (sid, agentId) => {
    set((s) => {
      const tabs = s.tabs.map((t) => {
        if (t.sid !== sid) return t;
        // Snapshot the leaving agent's view into messagesByAgent /
        // streamingByAgent so switching back later restores the current
        // thread + spinner state. Then restore the entering agent's slots
        // into tab.messages / tab.isStreaming (the active-agent mirror).
        const oldId = t.agentId;
        const messagesByAgent = { ...t.messagesByAgent };
        const streamingByAgent = { ...t.streamingByAgent };
        if (oldId) {
          messagesByAgent[oldId] = t.messages;
          streamingByAgent[oldId] = t.isStreaming;
        }
        const newMessages = agentId ? (messagesByAgent[agentId] ?? []) : [];
        const newStreaming = agentId ? Boolean(streamingByAgent[agentId]) : false;
        return {
          ...t,
          agentId,
          messages: newMessages,
          isStreaming: newStreaming,
          messagesByAgent,
          streamingByAgent,
        };
      });
      // sid 总是有效（=tab 主键），直接写 agentBySid 缓存。agentId=null 时显式
      // delete 这个 key，保持 map 紧凑（避免 stale 残留）。
      const agentBySid = { ...s.agentBySid };
      if (agentId) agentBySid[sid] = agentId;
      else delete agentBySid[sid];
      persistAgentBySid(agentBySid);
      const out: Partial<AppState> = { tabs, agentBySid };
      if (s.activeSid === sid) {
        const active = tabs.find((t) => t.sid === sid);
        if (active) {
          out.messages = active.messages;
          out.isStreaming = active.isStreaming;
        }
      }
      return out;
    });
  },

  agentBySid: loadAgentBySid(),
  getCachedAgentForSid: (sid) => {
    if (!sid) return null;
    return get().agentBySid[sid] ?? null;
  },
  // providerOverride 设置：写盘当默认 + mirror 到 active tab。switchToSession 时
  // mirror 自动从新 tab 的 providerOverride 拉过去，这俩 setter 不需要 tab-aware。
  setProviderOverride: (id) => {
    saveProviderOverride(id);
    set((s) => {
      if (!s.activeSid) return { providerOverride: id };
      return { providerOverride: id, ...patchTabField(s, s.activeSid, { providerOverride: id }) };
    });
  },
  // Agent install/uninstall —— localStorage 是 SSOT，server 端 prefs 是 mirror。
  // 写本地立刻生效（ChatAgentStrip 重渲染），同时尽力 POST 到 /api/prefs，让
  // 主 agent 的 delegate 工具下一轮拉到的列表也是过滤后的。POST 失败不回滚 ——
  // 服务端 fallback 是「全量可见」，最差也只是工具看到一些用户不想要的 agent。
  toggleAgentInstalled: (id) => {
    if (!id) return;
    set((s) => {
      const cur = s.uninstalledAgentIds;
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].sort();
      saveUninstalledAgentIds(next);
      void pushUninstalledAgentsToServer(next);
      return { uninstalledAgentIds: next };
    });
  },
  setAgentInstalled: (id, installed) => {
    if (!id) return;
    set((s) => {
      const cur = s.uninstalledAgentIds;
      const has = cur.includes(id);
      if (installed && !has) return {};
      if (!installed && has) return {};
      const next = installed
        ? cur.filter((x) => x !== id)
        : [...cur, id].sort();
      saveUninstalledAgentIds(next);
      void pushUninstalledAgentsToServer(next);
      return { uninstalledAgentIds: next };
    });
  },
  setDefaultBootstrapAgent: (id) => {
    saveDefaultBootstrapAgent(id);
    set({ defaultBootstrapAgent: id });
  },
  // currentSessionId 在重做后等价 activeSid（一一对应），setter 保留只是为了不
  // 破已有 import surface —— 但实际真正切 session 应该走 switchToSession()。这里
  // 只 mirror top-level 字段、不动 activeSid（防止误用导致状态机错乱）。
  setCurrentSessionId: (id) => {
    set({ currentSessionId: id });
  },

  loadSession: async (sid: string, agentPath: string) => {
    // R3 (2026-05-20) —— forgeax 每个 (sid, agentPath) 各自一份独立 ledger
    //   `<sid>/agents/<agentPath>/events/events-N.jsonl` + blobs/。
    // 这与 ref agenteam 「一个 agentId 一份 session ledger，subagent_launched
    // 携带 subagentId」的模型 *不同*：ref 那种 BFS 子 agent 在这里无意义 ——
    // 子 agent 各自的事件流由它自己的 (sid, subPath) ledger 持有，要看子 agent
    // 历史另调 `loadSession(sid, subPath)`。
    //
    // 渲染管线照旧：fetch JSONL → parse → trim 到上一个 compact_boundary →
    // 喂同一个 TurnAccumulator + MessageEffects pipeline，跟 live SSE 同款
    // callbacks 保证 tool-chip / 流式文字 / 子卡片位置完全一致。
    if (!sid || !agentPath) return;
    try {
      // R3.6 (2026-05-23) — Defense in depth for the agent-switch round-trip.
      // ChatPanel's `loadedKeysRef` Set already guards against re-loading the
      // same (sid, agent) twice per session, but a stale callsite or a future
      // refactor could still call us with a populated slot. Two failure modes
      // we care about:
      //   • Empty WAL clobber — fresh agent never persisted any events; old
      //     code wiped optimistic [user, asst_streaming] to []. Now we no-op
      //     when the slot has non-daemon content.
      //   • Partial WAL clobber — LLM failed (broken model, abort), so WAL
      //     has `user_input` but no `assistant_complete`. Replay yields just
      //     [user]; old code overwrote the in-memory [user, asst_error] with
      //     [user], hiding the error from the user. We treat the slot as
      //     authoritative whenever its tail assistant is in `streaming` /
      //     `error` status (i.e. WAL doesn't reflect terminal asst state).
      const tabSnap = useAppStore.getState().tabs.find((t) => t.sid === sid);
      const slotSnap = tabSnap?.messagesByAgent[agentPath]
        ?? (tabSnap?.agentId === agentPath ? tabSnap?.messages : undefined)
        ?? [];
      const nonDaemon = slotSnap.filter((m) => !m.id.startsWith('daemon-tick-'));
      const tailAsst = [...nonDaemon].reverse().find((m) => m.role === 'assistant');
      const slotHasUnpersistedAsst =
        nonDaemon.length > 0 && tailAsst !== undefined &&
        (tailAsst.status === 'streaming' || tailAsst.status === 'error');
      if (slotHasUnpersistedAsst) {
        // In-memory state is more recent than WAL — leave the slot alone.
        return;
      }
      // 1. 拉这一条 (sid, agentPath) 的 ledger raw JSONL（server 的
      //    fetch_session_events 已经做了「反扫到上一个 compact_boundary 即停」，
      //    我们这里仍 trimToCompactBoundary 一遍是兜底，万一未来 server 端
      //    behavior 改了或 boundary 出现在 shard 中间。
      const ndjson = await fetchSessionEventsNdjson(sid, agentPath);
      // checkpoint 回退点:rewind mask 在 compact trim 之前。挂起 boundary 的
      // 区间保留(UI 置灰渲染),已定格/已恢复的按语义滤掉 —— 与 server
      // context-window 的 applyRewindMask 同源语义(rewind-mask.ts 镜像)。
      const rawEvents = parseEventLines(ndjson);
      const pendingRw = findPendingRewind(rawEvents);
      const events = trimToCompactBoundary(
        applyRewindMask(rawEvents, pendingRw ? { keepBoundaryVisible: pendingRw.boundaryId } : {}),
      );
      if (events.length === 0) {
        // R3.6 — Don't wipe a populated slot. The cold-start path (slot has
        // only daemon-tick-* live bubbles or nothing) still falls through to
        // the original wipe below, but if there's any non-daemon content the
        // user has been seeing, preserve it rather than blanking it out.
        if (nonDaemon.length > 0) return;
        // 空 ledger —— 把该 (sid, agentPath) 的 messages 清空（保留 daemon-tick-* live 气泡）。
        // R3.5 (2026-05-23) — 不再要求 t.agentId === agentPath；写到 messagesByAgent[agentPath]
        // 即可，让用户在 Forge 切到 mochi 之前就能后台 prefetch mochi 的历史。
        set((s) => {
          const tabs = s.tabs.map((t) => {
            if (t.sid !== sid) return t;
            const prev = t.messagesByAgent[agentPath] ?? (t.agentId === agentPath ? t.messages : []);
            const liveDaemonMsgs = prev.filter((mm) => mm.id.startsWith('daemon-tick-'));
            const messagesByAgent = { ...t.messagesByAgent, [agentPath]: liveDaemonMsgs };
            if (t.agentId === agentPath) {
              return { ...t, messagesByAgent, messages: liveDaemonMsgs };
            }
            return { ...t, messagesByAgent };
          });
          const active = tabs.find((t) => t.sid === s.activeSid);
          return active && active.sid === sid && active.agentId === agentPath
            ? { tabs, messages: active.messages }
            : { tabs };
        });
        return;
      }

      // 2. 接 TurnAccumulator —— 跟 live SSE 同 callbacks。forgeax 路径下没有
      //    "main vs sub" 区别（一个 ledger = 一个 agent），全部走 mainCallbacks。
      const messages: ChatMessage[] = [];
      const replayEffects = makeInMemEffects(messages, newId);
      let replayContextPct = 0;
      const mainCbs = buildMainCallbacks(replayEffects);
      // Rebuild time-ordered segments[] AS the ledger events replay, in their
      // real arrival order, so the bubble shows the true "text → tools → text
      // → tools" rhythm. We can't recover this from the final flat message:
      // each agentic round's hook:assistantMessage REPLACES m.text (only the
      // last round survives) while tools accumulate with `at` offsets that
      // point into already-overwritten per-round text. The jsonl ledger does
      // preserve the full ordered history, so we append a segment per event
      // here instead. Only the replay path does this; live builds its own
      // segments via session-stream, and claude-code's live accumulator is a
      // different call site — neither is touched.
      // 来源 badge 的 **per-turn** 还原:内核路径账本在 hook:turnStart / assistantMessage
      //   payload 带 providerId(见 transcribe-turn.ts);原生 forgeax 路径不写 → 默认 'forgeax'。
      //   curPid 在 feed 循环里按「轮边界重置 + 轮内捕获」更新,onMessage 同步触发时读取,
      //   这样**每条 assistant 气泡拿自己那一轮的来源**(修复:全局取最后一个 → 1/2 都变 claude-code)。
      let curPid: string | undefined;
      const acc = new TurnAccumulator({
        ...mainCbs,
        onMessage: (msg) => {
          mainCbs.onMessage?.(msg);
          const ts = msg.timestamp ?? Date.now();
          if (msg.kind === 'assistant_complete') {
            const pid = curPid ?? 'forgeax'; // 未标记 = 原生 forgeax(与 live store.ts 默认一致)
            replayEffects.applyMain((m) => {
              let segs = m.segments ?? [];
              if (msg.thinking?.trim()) segs = appendChatSegment(segs, { kind: 'thinking', ts, text: msg.thinking });
              if (msg.text?.trim()) segs = appendChatSegment(segs, { kind: 'text', ts, text: msg.text });
              return { ...m, segments: segs, providerId: m.providerId ?? pid };
            });
          } else if (msg.kind === 'tool_call') {
            const tc = rendererToolCallToLegacy(msg as ToolCallMessage);
            replayEffects.applyMain((m) => ({ ...m, segments: upsertToolSegment(m.segments ?? [], ts, tc) }));
          }
        },
        onUpdateMessage: (callId, merged) => {
          mainCbs.onUpdateMessage?.(callId, merged);
          if (merged.kind === 'tool_call') {
            const tc = rendererToolCallToLegacy(merged as ToolCallMessage);
            replayEffects.applyMain((m) => ({ ...m, segments: upsertToolSegment(m.segments ?? [], Date.now(), tc) }));
          }
        },
        onMeta: (m) => { if (m.contextPct !== undefined) replayContextPct = m.contextPct; },
        onTurn: (turn) => {
          // Default handling (user_input → user bubble; inter-agent system →
          // applySystem banner). Then, at the boundary of a REAL agent turn
          // (not 'user'), seal the main bubble so the next forge turn opens a
          // fresh bubble AFTER any inter-agent (崽崽) cards applySystem appended
          // in between — matching the live WS path (session-stream spawns a new
          // streaming bubble per hook:turnStart). Without this, a forge thread
          // that takes multiple turns around sub-agent delegations replayed all
          // its text into ONE bubble with every inter-agent card piled at the
          // tail (the "卡片堆到后面 / 文本被合崽崽一起" restore bug).
          mainCbs.onTurn?.(turn);
          if (turn.agent && turn.agent !== 'user') replayEffects.sealMain?.();
        },
      }, agentPath);

      // 3. ts 升序喂入。ledger 本身就是 append 顺序，但 compact_boundary 边界
      //    + 多 shard merge 可能不严格 ts-monotonic，稳妥起见 sort 一次。
      const sorted = [...events].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
      for (const ev of sorted) {
        // per-turn providerId 跟踪(供 onMessage 同步读取):
        //   轮边界(user_input / hook:turnStart)重置为「该轮自己的 providerId」
        //   (内核路径写在 turnStart payload;原生路径无 → undefined → 默认 forgeax);
        //   轮内任意带 providerId 的事件(如 hook:assistantMessage)继续刷新。
        const p = (ev as { type?: string; payload?: { providerId?: unknown } }).payload;
        const pid = p && typeof p.providerId === 'string' && p.providerId ? p.providerId : undefined;
        if (ev.type === 'user_input' || ev.type === 'hook:turnStart') curPid = pid;
        else if (pid) curPid = pid;
        acc.feed(ev);
      }
      acc.flush();

      // 4. 历史读没有 live stream 终结点，把所有 streaming 状态翻 done。
      //    (segments[] are rebuilt incrementally in the accumulator above, in
      //    true ledger order — no post-hoc flattening pass.)
      finalizeStreamingStatus(messages);

      // 5. Commit 到 messagesByAgent[agentPath]。R3.5 (2026-05-23) — 多 agent
      //    并发场景：tab.agentId 可能不是 agentPath（用户当前在看 forge 但 mochi
      //    的 ledger 后台 prefetch 完了），此时写到 per-agent 冷存槽即可，切回
      //    mochi 的瞬间 setTabAgent 会从 messagesByAgent[mochi] 把它装回 tab.messages。
      //    daemon-tick-* live 气泡只在当前 active 那一份里才有意义，所以仍按
      //    "agent === active" 的旧规则保留。
      set((s) => {
        const tabs = s.tabs.map((t) => {
          if (t.sid !== sid) return t;
          const isActive = t.agentId === agentPath;
          const prev = t.messagesByAgent[agentPath] ?? (isActive ? t.messages : []);
          const liveDaemonMsgs = isActive ? prev.filter((mm) => mm.id.startsWith('daemon-tick-')) : [];
          const merged = liveDaemonMsgs.length === 0
            ? messages
            : [...messages, ...liveDaemonMsgs].sort((a, b) => a.ts - b.ts);
          const messagesByAgent = { ...t.messagesByAgent, [agentPath]: merged };
          const ctxPatch = isActive && replayContextPct > 0 ? { contextPct: replayContextPct } : {};
          if (isActive) {
            return { ...t, ...ctxPatch, messagesByAgent, messages: merged };
          }
          return { ...t, messagesByAgent };
        });
        const active = tabs.find((t) => t.sid === s.activeSid);
        return active && active.sid === sid && active.agentId === agentPath
          ? { tabs, messages: active.messages }
          : { tabs };
      });
    } catch (e) {
      console.warn('[loadSession] failed', (e as Error).message);
    }
  },

  loadThreadHistory: async (threadId: string) => {
    if (!threadId) return;
    try {
      const tr = await fetch(`/api/threads/${encodeURIComponent(threadId)}`);
      if (!tr.ok) return;
      const tj = (await tr.json()) as { thread?: { runIds?: string[] } };
      const runIds = tj.thread?.runIds ?? [];
      if (runIds.length === 0) return;

      // Per-run accumulator so the EventSource tail can keep building on top
      // of what the poll snapshot already returned.
      type RunBuild = {
        meta: {
          id: string;
          threadId: string;
          agentId: string;
          providerId: string;
          status: string;
          message: string;
          createdAt: number;
          lastEventAt: number;
        };
        events: AguiStoredEvent[];
      };
      const builds = new Map<string, RunBuild>();

      const built: ChatMessage[] = [];
      let inFlightRunId: string | null = null;
      for (const runId of runIds) {
        const rr = await fetch(`/api/runs/${encodeURIComponent(runId)}/events?stream=poll`);
        if (!rr.ok) continue;
        const rj = (await rr.json()) as { run?: RunBuild['meta']; events?: AguiStoredEvent[] };
        const meta = rj.run;
        if (!meta) continue;
        const evs = rj.events ?? [];
        builds.set(runId, { meta, events: evs });

        // User message lives in RunMeta.message — the AG-UI jsonl only captures
        // the response side (see runs/types.ts:RunMeta comment).
        if (meta.message) {
          built.push({
            id: `${runId}-user`,
            role: 'user',
            text: meta.message,
            toolCalls: [],
            status: 'done',
            ts: meta.createdAt,
          });
        }

        const a = consumeAguiEvents(evs);
        // For runs still alive server-side, keep the 'streaming' status so the
        // UI shows the spinner — the EventSource tail (below) will flip it to
        // done on RUN_FINISHED.
        const isLive = meta.status === 'streaming' || meta.status === 'starting';
        if (isLive) inFlightRunId = runId;
        built.push({
          id: `${runId}-asst`,
          role: 'assistant',
          text: a.text,
          thinking: a.thinking,
          toolCalls: a.toolCalls,
          segments: a.segments,
          status: isLive ? 'streaming' : a.status,
          ts: meta.lastEventAt || meta.createdAt + 1,
          providerId: meta.providerId,
        });
      }

      built.sort((a, b) => a.ts - b.ts);

      // Find the owning tab + commit messages + bind in-flight runId. R3 后
      // threadId === sid，直接用 sid 当 key。
      let ownerSid: string | null = null;
      set((s) => {
        const tabs = s.tabs.map((t) => {
          if (t.sid !== threadId) return t;
          if (!ownerSid) ownerSid = t.sid;
          return {
            ...t,
            messages: built,
            runId: inFlightRunId ?? t.runId,
            isStreaming: Boolean(inFlightRunId),
          };
        });
        const active = tabs.find((t) => t.sid === s.activeSid);
        return active && active.sid === threadId
          ? { tabs, messages: active.messages, isStreaming: Boolean(inFlightRunId) }
          : { tabs };
      });

      if (!ownerSid) return;
      const tailKey: string = ownerSid;

      // For each run still streaming on server, open EventSource tail with
      // Last-Event-Id pointed at the highest seq we already replayed.  Each
      // new event re-runs consumeAguiEvents on the full per-run accumulator
      // and patches the matching assistant ChatMessage in place — same
      // pattern as Dashboard RunsList.tsx (lines 533-557).
      closeThreadHistoryTails(tailKey);
      for (const [runId, b] of builds) {
        if (b.meta.status !== 'streaming' && b.meta.status !== 'starting') continue;
        const lastSeq = b.events.reduce((m, e) => Math.max(m, e.seq ?? -1), -1);
        const url =
          `/api/runs/${encodeURIComponent(runId)}/events?stream=sse` +
          (lastSeq >= 0 ? `&lastEventId=${encodeURIComponent(`${runId}:${lastSeq}`)}` : '');
        const es = new EventSource(url);
        trackTail(tailKey, es);

        const onAguiFrame = (raw: MessageEvent<string>): void => {
          try {
            const stored = JSON.parse(raw.data) as AguiStoredEvent;
            b.events.push(stored);
            const a = consumeAguiEvents(b.events);
            const isLive = a.status === 'streaming';
            set((s) => {
              const tabs = s.tabs.map((t) => {
                if (t.sid !== tailKey) return t;
                let touched = false;
                const messages = t.messages.map((m) => {
                  if (m.id !== `${runId}-asst`) return m;
                  touched = true;
                  return {
                    ...m,
                    text: a.text,
                    thinking: a.thinking,
                    toolCalls: a.toolCalls,
                    segments: a.segments,
                    status: a.status,
                    ts: stored.ts ?? m.ts,
                  };
                });
                const nextIsStreaming = isLive ? true : t.runId === runId ? false : t.isStreaming;
                return {
                  ...t,
                  messages: touched ? messages : t.messages,
                  isStreaming: nextIsStreaming,
                  runId: isLive ? runId : (t.runId === runId ? null : t.runId),
                };
              });
              const active = tabs.find((tb) => tb.sid === s.activeSid);
              return active && active.sid === tailKey
                ? { tabs, messages: active.messages, isStreaming: active.isStreaming }
                : { tabs };
            });
            if (!isLive) {
              try { es.close(); } catch { /* */ }
              untrackTail(tailKey, es);
            }
          } catch (e) {
            console.warn('[loadThreadHistory tail] parse failed', (e as Error).message);
          }
        };

        const TAIL_EVENTS = [
          'RUN_STARTED', 'RUN_FINISHED', 'RUN_ERROR',
          'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_CHUNK', 'TEXT_MESSAGE_END',
          'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_CHUNK', 'TOOL_CALL_END', 'TOOL_CALL_RESULT',
          'REASONING_START', 'REASONING_MESSAGE_START', 'REASONING_MESSAGE_CONTENT',
          'REASONING_MESSAGE_CHUNK', 'REASONING_MESSAGE_END', 'REASONING_END',
          'STEP_STARTED', 'STEP_FINISHED',
        ];
        for (const t of TAIL_EVENTS) es.addEventListener(t, onAguiFrame as EventListener);
        es.addEventListener('message', onAguiFrame as EventListener);
        es.onerror = () => {
          if (es.readyState === EventSource.CLOSED) untrackTail(tailKey, es);
        };
      }
    } catch (e) {
      console.warn('[loadThreadHistory] failed', (e as Error).message);
    }
  },

  consoleLog: [],
  pushConsole: (entry) => {
    recordLog('console', entry); // mirror to disk (.forgeax/logs/console.jsonl)
    set((s) => ({
      // Cap at 500 entries to bound memory; oldest drop off.
      consoleLog: s.consoleLog.length >= 500
        ? [...s.consoleLog.slice(s.consoleLog.length - 499), entry]
        : [...s.consoleLog, entry],
    }));
  },
  clearConsole: () => set({ consoleLog: [] }),

  networkLog: [],
  pushNetwork: (entry) => {
    recordLog('network', entry); // mirror to disk (.forgeax/logs/network.jsonl)
    set((s) => ({
      // Cap at 500 entries to bound memory; oldest drop off.
      networkLog: s.networkLog.length >= 500
        ? [...s.networkLog.slice(s.networkLog.length - 499), entry]
        : [...s.networkLog, entry],
    }));
  },
  clearNetwork: () => set({ networkLog: [] }),

  telemetry: [],
  pushTelemetry: (records) => {
    if (!records.length) return;
    set((s) => {
      const next = [...s.telemetry, ...records];
      // Cap at 500 records (S4); drop oldest.
      return { telemetry: next.length > 500 ? next.slice(next.length - 500) : next };
    });
  },
  clearTelemetry: () => set({ telemetry: [] }),

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

  openFiles: [],
  activeFilePath: null,

  openFile: async (path) => {
    // If already open, just activate it.
    if (get().openFiles.find((f) => f.path === path)) {
      set({ activeFilePath: path, mode: 'workbench', workbenchTab: 'files', workbenchExpandedPluginId: null });
      return;
    }
    const addFile = (file: PreviewFile) =>
      set((s) => ({
        openFiles: [...s.openFiles.filter((f) => f.path !== path), file],
        activeFilePath: path,
        mode: 'workbench',
        workbenchTab: 'files',
        workbenchExpandedPluginId: null,
      }));
    try {
      const r = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
      if (!r.ok) {
        // Friendly, explanatory message instead of a raw "[error] 400 Bad Request".
        // The AGENTS file-activity ledger lists every file an agent *touched*,
        // including engine / library source it only READ — those live outside the
        // editable workspace (only .forgeax/games/** and packages/** are served),
        // so they 400. A 404 means the path no longer exists (moved/renamed/never
        // there — e.g. opening `index.ts` in a game whose entry is `main.ts`).
        let serverMsg = '';
        try { serverMsg = ((await r.json()) as { error?: string }).error ?? ''; } catch { /* non-JSON */ }
        const friendly = r.status === 400
          ? t('store.openFile.notInWorkspace', { path }) + (serverMsg ? t('store.openFile.serverDetail', { serverMsg }) : '')
          : r.status === 404
            ? t('store.openFile.notFound', { path })
            : t('store.openFile.failed', { path, status: r.status, statusText: r.statusText }) + (serverMsg ? ` — ${serverMsg}` : '');
        addFile({ path, kind: 'text', mime: 'text/plain', bytes: 0,
          content: friendly,
          error: serverMsg || `${r.status} ${r.statusText}` });
        return;
      }
      const j = (await r.json()) as {
        kind?: 'text' | 'image' | 'audio' | 'video' | 'model' | 'binary';
        mime?: string;
        size?: number;
        content?: string;
      };
      addFile({
        path,
        kind: j.kind ?? 'text',
        mime: j.mime ?? 'application/octet-stream',
        bytes: j.size ?? 0,
        content: j.kind === 'text' || !j.kind ? (j.content ?? '') : undefined,
      });
    } catch (e) {
      addFile({ path, kind: 'text', mime: 'text/plain', bytes: 0,
        content: `[error] ${(e as Error).message}`,
        error: (e as Error).message });
    }
  },

  openFileDirect: (file) => {
    set((s) => ({
      openFiles: [...s.openFiles.filter((f) => f.path !== file.path), file],
      activeFilePath: file.path,
      mode: 'workbench',
      workbenchTab: 'files',
      workbenchExpandedPluginId: null,
    }));
  },

  activateFile: (path) => {
    if (!get().openFiles.find((f) => f.path === path)) return;
    set({ activeFilePath: path });
  },

  closeFile: (path) => {
    set((s) => {
      const target = path ?? s.activeFilePath;
      if (!target) return {};
      const remaining = s.openFiles.filter((f) => f.path !== target);
      let nextActive = s.activeFilePath;
      if (s.activeFilePath === target) {
        // Pick the tab to the left, or the first remaining tab.
        const idx = s.openFiles.findIndex((f) => f.path === target);
        nextActive = remaining[Math.max(0, idx - 1)]?.path ?? remaining[0]?.path ?? null;
      }
      return { openFiles: remaining, activeFilePath: nextActive };
    });
  },

  updatePreviewContent: (content) => set((s) => {
    if (!s.activeFilePath) return {};
    const file = s.openFiles.find((f) => f.path === s.activeFilePath);
    if (!file || file.kind !== 'text') return {};
    return {
      openFiles: s.openFiles.map((f) =>
        f.path === s.activeFilePath ? { ...f, content, dirty: true } : f,
      ),
    };
  }),

  savePreviewFile: async () => {
    const { openFiles, activeFilePath } = get();
    const file = openFiles.find((f) => f.path === activeFilePath);
    if (!file) return { ok: false, error: 'no file open' };
    if (file.kind !== 'text') return { ok: false, error: 'binary files are read-only' };
    try {
      const r = await fetch('/api/files', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: file.path, content: file.content ?? '' }),
      });
      const j = (await r.json()) as { bytes?: number; error?: string };
      if (!r.ok) return { ok: false, error: j.error ?? `HTTP ${r.status}` };
      set((s) => ({
        openFiles: s.openFiles.map((f) =>
          f.path === file.path ? { ...f, dirty: false, bytes: j.bytes ?? f.bytes } : f,
        ),
      }));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  // ── Tab-aware messages/streaming state (P6 step 1) ──
  // The data lives in `tabs[active].messages` etc.; these top-level fields
  // are a *mirror* of the active tab for back-compat with components that
  // already do `useAppStore(s => s.messages)`. Initial values come from the
  // persisted-tabs loader so the first render sees the right tab content.
  //
  // Note: TS narrows spread types to optional; we re-state the literal fields
  // below so all required AppState slots are present at init time. The earlier
  // `providerOverride: null` / `currentSessionId: null` declarations are then
  // overridden by the spread.
  ..._initialMirror,

  clearMessages: () => set((s) => s.activeSid ? patchTabMessages(s, s.activeSid, () => []) : {}),

  // ── Message queue ────────────────────────────────────────────────────────
  enqueueMessage: (text) => {
    const t = text.trim();
    if (!t) return;
    const { activeSid, tabs } = get();
    if (!activeSid) return;
    const agentId = tabs.find((tab) => tab.sid === activeSid)?.agentId ?? null;
    if (!agentId) return;
    const key = `${activeSid}::${agentId}`;
    const item: QueuedMessage = {
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: t,
      ts: Date.now(),
    };
    set((s) => ({
      queuedMessages: { ...s.queuedMessages, [key]: [...(s.queuedMessages[key] ?? []), item] },
    }));
  },

  dequeueMessage: (id) => {
    const { activeSid, tabs } = get();
    if (!activeSid) return;
    const agentId = tabs.find((tab) => tab.sid === activeSid)?.agentId ?? null;
    if (!agentId) return;
    const key = `${activeSid}::${agentId}`;
    set((s) => {
      const cur = s.queuedMessages[key] ?? [];
      const next = cur.filter((m) => m.id !== id);
      return { queuedMessages: { ...s.queuedMessages, [key]: next } };
    });
  },

  clearQueue: () => {
    const { activeSid, tabs } = get();
    if (!activeSid) return;
    const agentId = tabs.find((tab) => tab.sid === activeSid)?.agentId ?? null;
    if (!agentId) return;
    const key = `${activeSid}::${agentId}`;
    set((s) => {
      if (!(key in s.queuedMessages)) return {};
      const next = { ...s.queuedMessages };
      delete next[key];
      return { queuedMessages: next };
    });
  },

  flushQueuedForAgent: (sid, agentId) => {
    const key = `${sid}::${agentId}`;
    const cur = get().queuedMessages[key] ?? [];
    if (cur.length === 0) return;
    const [head, ...rest] = cur;
    set((s) => ({ queuedMessages: { ...s.queuedMessages, [key]: rest } }));
    // Re-send through the normal path. flushQueuedForAgent only fires from a
    // natural turnEnd (session-stream), at which point the agent is no longer
    // streaming, so sendMessage takes its normal pre-push branch and starts a
    // fresh turn — giving strictly sequential, one-turn-per-message processing.
    void get().sendMessage(head.text);
  },

  cancelStream: () => {
    const { activeSid, tabs } = get();
    if (!activeSid) return;
    const tab = tabs.find((t) => t.sid === activeSid);

    // 1. Abort the client SSE （CLI provider 路径用 —— 停 spinner + 释放
    //    AbortController；forgeax 原生路径 _abortByTab 不存这个）。
    const c = _abortByTab.get(activeSid);
    if (c) {
      c.abort();
      _abortByTab.delete(activeSid);
    }

    // 2. CLI provider 路径：取消 server 上的 Run。Without this, cli 子进程
    //    会跑到自然结束，Dashboard 上 Run 永远 streaming。Fire-and-forget。
    const runId = tab?.runId ?? null;
    if (runId) {
      fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
        .catch((e) => console.warn('[cancelStream] run cancel POST failed', (e as Error).message));
    }

    // 3. forgeax 原生路径：让 server scheduler.interruptAgents 中断 ConsciousAgent
    //    的当前 turn —— abortController.abort() → LLM fetch signal → loop break →
    //    finally 里 hook:turnEnd { aborted: true } emit，前端 isStreaming 自动清。
    //    带 active agent 时只断那一个，否则整 session 全断。Fire-and-forget；
    //    server 没这个 session（可能已被 LRU 软关）就 404 忽略，下次新 turn 不影响。
    const agent = tab?.agentId ?? null;
    const qs = agent ? `?agent=${encodeURIComponent(agent)}` : '';
    fetch(`/api/sessions/${encodeURIComponent(activeSid)}/abort${qs}`, { method: 'POST' })
      .catch((e) => console.warn('[cancelStream] session abort POST failed', (e as Error).message));

    closeThreadHistoryTails(activeSid);
  },

  initSessions: async () => {
    if (_initSessionsPending) return _initSessionsPending;
    _initSessionsPending = (async () => {
      const { fetchSessionList, createSession, connectForgeaXWs } = await import('./lib/forgeax-bridge');
      try {
        let metas = await fetchSessionList();
        if (metas.length === 0) {
          // 真空态：兜底建一条。**不**传 displayName / defaultDir —— 让 server 端
          // 缺省决定，UI 走 tabLabel 占位规则反映"无名"真值，不再硬塞 default。
          const { sid } = await createSession({ autoStart: true });
          metas = await fetchSessionList();
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
          runId: null,
          providerOverride: get().providerOverride,
          messages: [],
          isStreaming: false,
          messagesByAgent: {},
          streamingByAgent: {},
          contextPct: 0,
          lastActivityAt: m.lastActivityAt,
          pendingRewind: null,
          rewindDirtyNotice: null,
          checkpointMsgIds: {},
        }));
        // localStorage 上次的 active sid 优先（如果还在 list 里），否则 tabs[0]。
        const persisted = loadActiveSid();
        const active = persisted && newTabs.some((t) => t.sid === persisted)
          ? persisted
          : (newTabs[0]?.sid ?? null);
        const activeTab = newTabs.find((t) => t.sid === active) ?? null;
        set({
          tabs: newTabs,
          activeSid: active,
          messages: activeTab?.messages ?? [],
          isStreaming: activeTab?.isStreaming ?? false,
          currentSessionId: active,
          providerOverride: activeTab?.providerOverride ?? get().providerOverride,
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
    const { fetchSessionList } = await import('./lib/forgeax-bridge');
    try {
      const metas = await fetchSessionList();
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
            runId: null,
            providerOverride: s.providerOverride,
            messages: [],
            isStreaming: false,
            messagesByAgent: {},
            streamingByAgent: {},
            contextPct: 0,
            lastActivityAt: m.lastActivityAt,
            pendingRewind: null,
            rewindDirtyNotice: null,
            checkpointMsgIds: {},
          };
        });
        // 如果 active 还在新 list 里就保留，否则掉到 [0]。空 list → null。
        const active = s.activeSid && merged.some((t) => t.sid === s.activeSid)
          ? s.activeSid
          : (merged[0]?.sid ?? null);
        const activeTab = merged.find((t) => t.sid === active) ?? null;
        persistActiveSid(active);
        return {
          tabs: merged,
          activeSid: active,
          messages: activeTab?.messages ?? [],
          isStreaming: activeTab?.isStreaming ?? false,
          currentSessionId: active,
          providerOverride: activeTab?.providerOverride ?? s.providerOverride,
        };
      });
    } catch (e) {
      console.warn('[refreshSessions] failed', e);
    }
  },

  createNewSession: async (opts) => {
    const { createSession, connectForgeaXWs } = await import('./lib/forgeax-bridge');
    try {
      const bootstrap = get().defaultBootstrapAgent;
      const { sid } = await createSession({
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
      set((s) => {
        const newTab: ChatTab = {
          sid,
          displayName: opts?.displayName,
          agentId: null,
          runId: null,
          providerOverride: seedOverride,
          messages: [],
          isStreaming: false,
          messagesByAgent: {},
          streamingByAgent: {},
          contextPct: 0,
          pendingRewind: null,
          rewindDirtyNotice: null,
          checkpointMsgIds: {},
        };
        const tabs = [...s.tabs, newTab];
        persistActiveSid(sid);
        return {
          tabs,
          activeSid: sid,
          messages: [],
          isStreaming: false,
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
    set({
      activeSid: sid,
      messages: target.messages,
      isStreaming: target.isStreaming,
      currentSessionId: sid,
      providerOverride: target.providerOverride,
    });
    persistActiveSid(sid);
    const { connectForgeaXWs } = await import('./lib/forgeax-bridge');
    connectForgeaXWs(sid);
    void _syncActiveAgentRunning(sid);
  },

  closeSession: async (sid) => {
    // liveAgents / agentFileActivity 是按 sid 累积的 write-only map(session-stream
    // 与 AgentsPanel 轮询只增不删);关 session 必须随 tab 一起摘除,否则每个关闭的
    // session 都把整棵 agent 树 + 文件活动记录永久滞留在 store 里(内存泄漏 case-05)。
    const omitSessionResidue = (s: Pick<AppState, 'liveAgents' | 'agentFileActivity' | 'agentBySid' | 'queuedMessages'>) => {
      const { [sid]: _la, ...liveAgents } = s.liveAgents;
      const { [sid]: _fa, ...agentFileActivity } = s.agentFileActivity;
      // case-06: agentBySid 也按 sid 累积,且 setTabAgent 把它持久化进 localStorage
      // ('forgeax.agentBySid')。关 session 不摘 → 孤儿条目在内存 + 磁盘双重无界
      // 累积、跨刷新永不回收。随 tab 一起摘掉并回写盘(与 setTabAgent 一致)。
      const { [sid]: _ab, ...agentBySid } = s.agentBySid;
      persistAgentBySid(agentBySid);
      // case-07: queuedMessages 以 `${sid}::${agentId}` 复合键累积(发送中排队),
      // 只在 flush/clearQueue 时删。关 session 时尚未 flush 的队列(含完整消息体)
      // 永久滞留 → 摘掉所有 sid-part 命中的复合键。
      const queuedMessages = Object.fromEntries(
        Object.entries(s.queuedMessages).filter(([k]) => k.split('::')[0] !== sid),
      );
      return { liveAgents, agentFileActivity, agentBySid, queuedMessages };
    };
    // 1. abort in-flight stream first —— 不让被删的 session 还在写数据。
    const c = _abortByTab.get(sid);
    if (c) { c.abort(); _abortByTab.delete(sid); }
    closeThreadHistoryTails(sid);
    // case-10: file-activity-stream 的模块级 _state Map 按 sid 累积(file-activity
    // 事件触发 getOrInit),只增不删 → 每个关闭的 session 永久滞留一个条目。随 tab
    // 一起摘除(与 closeThreadHistoryTails 同为 per-sid 模块清理)。
    void import('./lib/file-activity-stream').then((m) => m.dropFileActivitySession(sid));
    // case-12 (MEMLEAK_CASE12_DAEMON_TICK_KEY): _tickMsgIdByTickId 以 `${sid}::${tickId}`
    // 累积(daemon-tick-start 注册,只在 daemon-tick-end 删)。关 session 时在飞的 tick
    // 收不到 end(handleDaemonWs 的 `!tab` 守卫会丢弃已关 session 的 tick-end)→ 孤儿
    // 条目永久滞留模块级 Map。随 tab 一起摘掉所有 sid 命中的复合键(与 queuedMessages
    // case-07 同型的 per-sid 模块清理)。
    for (const k of [..._tickMsgIdByTickId.keys()]) {
      if (k.slice(0, sid.length + 2) === `${sid}::`) _tickMsgIdByTickId.delete(k);
    }

    // 2. 真删盘 —— DELETE /api/sessions/:sid。失败也照常往下走（盘上残留比 UI
    //    幽灵 tab 还在更可接受），错误吐到控制台。
    const { deleteSession, connectForgeaXWs, createSession } = await import('./lib/forgeax-bridge');
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
          runId: null,
          providerOverride: loadProviderOverride(),
          messages: [],
          isStreaming: false,
          messagesByAgent: {},
          streamingByAgent: {},
          contextPct: 0,
          pendingRewind: null,
          rewindDirtyNotice: null,
          checkpointMsgIds: {},
        };
        set((s) => ({
          tabs: [fresh],
          activeSid: newSid,
          messages: [],
          isStreaming: false,
          currentSessionId: newSid,
          providerOverride: fresh.providerOverride,
          ...omitSessionResidue(s),
        }));
        persistActiveSid(newSid);
        connectForgeaXWs(newSid);
        void _syncActiveAgentRunning(newSid);
        return;
      } catch (e) {
        console.error('[closeSession] auto-create after empty failed', e);
        set((s) => ({ tabs: [], activeSid: null, messages: [], isStreaming: false, currentSessionId: null, ...omitSessionResidue(s) }));
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
        messages: next.messages,
        isStreaming: next.isStreaming,
        currentSessionId: next.sid,
        providerOverride: next.providerOverride,
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

  dashboardOpen: false,
  setDashboardOpen: (open) => set({ dashboardOpen: open }),
  settingsOpen: false,
  // 持久化在 localStorage —— 关掉 settings 面板再打开时回到上次的 tab；
  // 显式 openSettings(section) 仍能强制覆盖（深链/快捷打开特定页）。
  settingsSection: loadSettingsSection(),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setSettingsSection: (id) => {
    saveSettingsSection(id);
    set({ settingsSection: id });
  },
  openSettings: (section) => {
    const id = section ?? get().settingsSection ?? null;
    saveSettingsSection(id);
    set({ settingsOpen: true, settingsSection: id });
  },

  fullscreen: false,
  setFullscreen: (v) => set({ fullscreen: v }),
  toggleFullscreen: () => set((s) => ({ fullscreen: !s.fullscreen })),

  sidebarCollapsed: false,
  chatpanelCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  toggleChatpanel: () => set((s) => ({ chatpanelCollapsed: !s.chatpanelCollapsed })),

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

  sendMessage: async (text, opts) => {
    if (!text.trim()) return;
    const trimmed = text.trim();
    const { activeSid: startSid } = get();
    if (!startSid) {
      // 没活跃 session（boot 中 / initSessions 失败 / sessions 真为空）。
      // ChatPanel 应该已经在空态了，正常情况下用户根本进不到这条路径；
      // 兜底防万一（外部 keyboard shortcut 之类直接调 sendMessage）。
      console.warn('[sendMessage] no active session');
      return;
    }

    // /loop <intervalSec> <prompt>  → create + start a long-running daemon
    // whose ticks render as turns in this ChatPanel thread. Single entry
    // point, single history surface.
    const loopMatch = trimmed.match(/^\/loop\s+(\d+)\s+(.+)$/s);
    if (loopMatch) {
      const intervalSec = Math.max(15, Math.min(3600, Number(loopMatch[1])));
      const inlinePrompt = loopMatch[2].trim();
      const daemonId = `chat-loop-${Date.now().toString(36)}`;
      const activeTab = get().tabs.find((t) => t.sid === startSid);
      const payload = {
        id: daemonId,
        name: `Loop · ${inlinePrompt.slice(0, 32).replace(/\s+/g, ' ')}`,
        inlinePrompt,
        promptFile: '',
        cwd: '/tmp',
        intervalSec,
        cliProvider: 'claude-code',
        agentPersona: activeTab?.agentId ?? undefined,
        sourceThreadId: startSid,
        autoStart: true,
      };
      try {
        const r = await fetch('/api/daemons', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const j = await r.json();
        const sysMsg: ChatMessage = {
          id: newId(),
          role: 'system',
          text: r.ok
            ? t('store.loop.started', { daemonId, intervalSec })
            : t('store.loop.createFailed', { error: j.error ?? r.status }),
          toolCalls: [],
          status: 'done',
          ts: Date.now(),
        };
        set((s) => patchTabMessages(s, startSid, (msgs) => [...msgs, sysMsg]));
      } catch (e) {
        const sysMsg: ChatMessage = {
          id: newId(),
          role: 'system',
          text: t('store.loop.networkError', { message: (e as Error).message }),
          toolCalls: [],
          status: 'done',
          ts: Date.now(),
        };
        set((s) => patchTabMessages(s, startSid, (msgs) => [...msgs, sysMsg]));
      }
      return;
    }
    // `/tool <surface> <action> [jsonArgs]` — split-surface plugin RPC.
    // Dispatches via the bus surface store (Map-backed). Result renders inline
    // as a system message. Doc: docs/v2-vision/modules/16-three-pane-embedding.md §11.
    const toolMatch = trimmed.match(/^\/tool\s+(\S+)\s+(\S+)(?:\s+(.+))?$/s);
    if (toolMatch) {
      const surfaceId = toolMatch[1];
      const action = toolMatch[2];
      const argsRaw = toolMatch[3]?.trim();
      let args: unknown = undefined;
      if (argsRaw) {
        try {
          args = JSON.parse(argsRaw);
        } catch (e) {
          const sysMsg: ChatMessage = {
            id: newId(),
            role: 'system',
            text: t('store.tool.invalidJson', { message: (e as Error).message }),
            toolCalls: [],
            status: 'done',
            ts: Date.now(),
          };
          set((s) => patchTabMessages(s, startSid, (msgs) => [...msgs, sysMsg]));
          return;
        }
      }
      const userMsg: ChatMessage = {
        id: newId(),
        role: 'user',
        text: trimmed,
        toolCalls: [],
        status: 'done',
        ts: Date.now(),
      };
      set((s) => patchTabMessages(s, startSid, (msgs) => [...msgs, userMsg]));
      try {
        const r = await fetch(`/api/bus/ui/surfaces/${encodeURIComponent(surfaceId)}/dispatch`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, args, awaitAck: true, timeoutMs: 30000 }),
        });
        const j = await r.json();
        const sysMsg: ChatMessage = {
          id: newId(),
          role: 'system',
          text: r.ok && j.ok !== false
            ? `✅ \`${surfaceId}.${action}\` ok\n\n\`\`\`json\n${JSON.stringify(j.result ?? j, null, 2)}\n\`\`\``
            : `❌ \`${surfaceId}.${action}\` failed: ${j.error ?? j.message ?? r.status}`,
          toolCalls: [],
          status: 'done',
          ts: Date.now(),
        };
        set((s) => patchTabMessages(s, startSid, (msgs) => [...msgs, sysMsg]));
      } catch (e) {
        const sysMsg: ChatMessage = {
          id: newId(),
          role: 'system',
          text: t('store.tool.networkError', { message: (e as Error).message }),
          toolCalls: [],
          status: 'done',
          ts: Date.now(),
        };
        set((s) => patchTabMessages(s, startSid, (msgs) => [...msgs, sysMsg]));
      }
      return;
    }
    // Generic server command dispatch — `/<name> [args...]` routes to
    // POST /api/commands/<name>/execute. Mirrors agenteam's command system:
    // UI sends positional args (space-split for simple commands like /compact,
    // or the full tail as a single arg for free-text commands).
    // Only triggers for names matching [a-z_-] to avoid false positives on
    // paths like `/tool` or `/loop` (already handled above).
    const cmdMatch = trimmed.match(/^\/([a-z][a-z0-9_-]*)(?:\s+(.*))?$/s);
    if (cmdMatch) {
      const cmdName = cmdMatch[1];
      const cmdArgs = cmdMatch[2]?.trim() || '';
      const activeTab = get().tabs.find((t) => t.sid === startSid);
      const agentId = activeTab?.agentId ?? null;
      const userMsg: ChatMessage = {
        id: newId(),
        role: 'user',
        text: trimmed,
        toolCalls: [],
        status: 'done',
        ts: Date.now(),
      };
      set((s) => patchTabMessages(s, startSid, (msgs) => [...msgs, userMsg]));
      // Show a pending indicator while the command runs (compaction can take 10-30s).
      const pendingId = newId();
      const pendingMsg: ChatMessage = {
        id: pendingId,
        role: 'system',
        text: `⏳ /${cmdName} running...`,
        toolCalls: [],
        status: 'done',
        ts: Date.now(),
      };
      set((s) => patchTabMessages(s, startSid, (msgs) => [...msgs, pendingMsg]));
      try {
        const r = await fetch(`/api/commands/${encodeURIComponent(cmdName)}/execute`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            args: cmdArgs ? cmdArgs.split(/\s+/) : [],
            sessionId: startSid,
            requestingAgentId: agentId ?? undefined,
          }),
        });
        const j = await r.json();
        const result = j.result;
        const sysText = result?.ok !== false
          ? `✅ /${cmdName} → ${typeof result?.data === 'string' ? result.data : JSON.stringify(result?.data ?? result)}`
          : `❌ /${cmdName}: ${result?.error ?? 'unknown error'}`;
        set((s) => patchTabMessages(s, startSid, (msgs) =>
          msgs.map((m) => m.id === pendingId ? { ...m, text: sysText, ts: Date.now() } : m),
        ));
      } catch (e) {
        set((s) => patchTabMessages(s, startSid, (msgs) =>
          msgs.map((m) => m.id === pendingId ? { ...m, text: t('store.command.networkError', { cmdName, message: (e as Error).message }), ts: Date.now() } : m),
        ));
      }
      return;
    }
    // Resolve the chat target from the active tab's first-class agentId
    // binding. tab 跟 sid 一一对应，agentId pin 后 sendMessage 直接读。
    const activeTab = get().tabs.find((t) => t.sid === startSid);
    const mentionMatch = trimmed.match(/^@([a-zA-Z][a-zA-Z0-9_-]{0,39})\s+/);
    const mentionedAgent = mentionMatch?.[1];
    const agentId = mentionedAgent ?? activeTab?.agentId ?? null;
    if (!agentId) {
      const sysMsg: ChatMessage = {
        id: newId(),
        role: 'system',
        text: t('store.noAgentSelected'),
        toolCalls: [],
        status: 'done',
        ts: Date.now(),
      };
      set((s) => patchTabMessages(s, startSid, (msgs) => [...msgs, sysMsg]));
      return;
    }
    const activeAgent = agentId;

    // ── Interrupt-send (steer) ───────────────────────────────────────────
    // Deliver immediately with EventQueue handoff 'steer': the server's onSteer
    // listener aborts the running turn, then processes this message as the next
    // turn. We push ONLY the user bubble — no assistant bubble, no isStreaming
    // toggle, no client AbortController churn. The in-flight assistant bubble
    // flips to 'done' on its abort-driven turnEnd (findStreamingAsst now scans
    // for the last streaming bubble, so the trailing user line doesn't hide it),
    // and the new turn's hook:turnStart spawns a fresh assistant bubble.
    // Only meaningful on the forgeax-native path; the Composer only surfaces the
    // interrupt affordance there.
    if (opts?.handoff === 'steer') {
      const steerUserMsg: ChatMessage = {
        id: newId(), role: 'user', text: trimmed, toolCalls: [], status: 'done', ts: Date.now(),
      };
      set((s) => patchAgentMessages(s, startSid, activeAgent, (msgs) => [...msgs, steerUserMsg]));
      try {
        const { emitForgeaXMessage } = await import('./lib/forgeax-bridge');
        const { markEmittedClientMsg } = await import('./lib/session-stream');
        const candidate = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : undefined;
        const clientMsgId = `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        markEmittedClientMsg(clientMsgId);
        const r = await emitForgeaXMessage(startSid, expandPills(trimmed), {
          to: candidate,
          payload: { agentId, clientMsgId, ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}) },
          handoff: 'steer',
        });
        if (!r.ok) throw new Error(r.error ?? 'emit failed');
      } catch (e) {
        set((s) => patchTabMessages(s, startSid, (msgs) => [...msgs, {
          id: newId(), role: 'system',
          text: t('store.steer.sendFailed', { message: (e as Error).message }),
          toolCalls: [], status: 'done', ts: Date.now(),
        }]));
      }
      return;
    }

    const userMsg: ChatMessage = {
      id: newId(),
      role: 'user',
      text: trimmed,
      toolCalls: [],
      status: 'done',
      ts: Date.now(),
    };
    const asstMsg: ChatMessage = {
      id: newId(),
      role: 'assistant',
      text: '',
      toolCalls: [],
      status: 'streaming',
      ts: Date.now(),
    };
    // Per-sid AbortController. Cancelling session A doesn't touch session B's
    // stream; switching tab (= switching session) mid-stream doesn't cancel
    // anything (each session keeps its own controller).
    const old = _abortByTab.get(startSid);
    if (old) old.abort();
    const aborter = new AbortController();
    _abortByTab.set(startSid, aborter);
    const signal = aborter.signal;
    // Auto-title the tab from the first user message —— displayName 是 server
    // 真值，但 server 端 PATCH 接口还没落，先在内存里改 displayName 给用户即时
    // 反馈；refreshSessions 时会 revert 到 server 真值（undefined 时走 tabLabel
    // 占位）。 TODO: 等 PATCH /api/sessions/:sid { displayName } 写盘。
    set((s) => {
      const tab = s.tabs.find((t) => t.sid === startSid);
      const titlePatch: Partial<ChatTab> = tab && !tab.displayName
        ? { displayName: expandPills(trimmed).slice(0, 40).replace(/\s+/g, ' ') }
        : {};
      const tabs = s.tabs.map((t) => {
        if (t.sid !== startSid) return t;
        const targetSlot = activeAgent;
        // Pre-push lands in the *target* agent's slot — typically equal to
        // t.agentId (user clicked the avatar then typed) but can diverge for
        // `@mention` sends. When the target slot is also the active pin we
        // mirror into tab.messages / tab.isStreaming for the legacy single-
        // slot consumers; when it's a non-active slot we just bump
        // messagesByAgent / streamingByAgent (the user will see it the moment
        // they switch tabs to that agent).
        const prevSlot = t.messagesByAgent[targetSlot] ?? (t.agentId === targetSlot ? t.messages : []);
        const nextSlot = [...prevSlot, userMsg, asstMsg];
        const messagesByAgent = { ...t.messagesByAgent, [targetSlot]: nextSlot };
        const streamingByAgent = { ...t.streamingByAgent, [targetSlot]: true };
        if (t.agentId === targetSlot) {
          return { ...t, ...titlePatch, isStreaming: true, messages: nextSlot, messagesByAgent, streamingByAgent };
        }
        return { ...t, ...titlePatch, messagesByAgent, streamingByAgent };
      });
      const out: Partial<AppState> = { tabs };
      if (s.activeSid === startSid) {
        const refreshed = tabs.find((t) => t.sid === startSid);
        if (refreshed) {
          out.messages = refreshed.messages;
          out.isStreaming = refreshed.isStreaming;
        }
      }
      return out;
    });

    const patchAsst = (mut: (m: ChatMessage) => ChatMessage) => {
      set((s) => patchAgentMessages(s, startSid, activeAgent, (msgs) =>
        msgs.map((m) => (m.id === asstMsg.id ? mut(m) : m)),
      ));
    };

    // Per-tab provider override —— captured at send time.
    const startTab = get().tabs.find((t) => t.sid === startSid);
    const turnOverride = startTab?.providerOverride ?? null;

    const setTabStreaming = (val: boolean): void => {
      set((s) => {
        const tabs = s.tabs.map((t) => {
          if (t.sid !== startSid) return t;
          const streamingByAgent = { ...t.streamingByAgent, [activeAgent]: val };
          if (t.agentId === activeAgent) {
            return { ...t, streamingByAgent, isStreaming: val };
          }
          return { ...t, streamingByAgent };
        });
        const out: Partial<AppState> = { tabs };
        if (s.activeSid === startSid) {
          const refreshed = tabs.find((t) => t.sid === startSid);
          if (refreshed) out.isStreaming = refreshed.isStreaming;
        }
        return out;
      });
    };

    // R3 provider 分流（2026-05-20 引入，2026-05-25 校准）：
    //   - `null` / `'forgeax'`  → POST /api/sessions/:sid/messages（forgeax 原生）。
    //     null 是默认 = forgeax。server 端 ConsciousAgent.runMain 已接通（B1.9）：
    //     event 落 EventBus → 路由到目标 agent EventQueue → runAgentLoop 拿 LLM
    //     provider 真起 turn，stream:llm chunks / hook:assistantMessage /
    //     hook:turnEnd 等事件通过 WS broadcast 回来，由 session-stream.ts 归并
    //     到对应 message bubble。所有 agent（root / mochi / iori / suzu / …）走
    //     同一份 ConsciousAgent + Scheduler 路径，没有 root 特化；第一次发给未
    //     存在的 marketplace persona 时 server 会 auto-scaffold + attach + start。
    //   - claude-code / codex / …  → POST /api/cli/chat（临时 cli-provider 桥，
    //     带 Deprecation header，最终被 commands.attach_script_agent 取代）。
    const isForgeaXNative = turnOverride === null || turnOverride === 'forgeax';
    if (isForgeaXNative) {
      try {
        const { emitForgeaXMessage } = await import('./lib/forgeax-bridge');
        const { markEmittedClientMsg } = await import('./lib/session-stream');
        // Marketplace persona ids (mochi / kotone / cc-coder / ...) are
        // forwarded as-is. Server-side /api/sessions/:sid/messages handler
        // recognizes single-segment `to` that isn't yet in tree, and if it
        // matches a known plugin / marketplace persona, auto-scaffolds the
        // sub-agent with personaFile pre-populated before routing the event.
        // Without an explicit pin we leave `to` undefined and the event lands
        // as a session-wide broadcast to the bootstrap root agent.
        const candidate = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : undefined;
        const targetAgent = candidate;
        const clientMsgId = `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        markEmittedClientMsg(clientMsgId);
        const r = await emitForgeaXMessage(startSid, expandPills(trimmed), {
          to: targetAgent,
          payload: { agentId, clientMsgId, ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}) },
        });
        if (!r.ok) throw new Error(r.error ?? 'emit failed');
        // checkpoint:server 注入并回传 msgId —— 补到预 push 的 user 气泡,并
        // 乐观登记该消息有回退点(server 在响应前已同步打完快照)。
        if (r.msgId) {
          const mid = r.msgId;
          set((s) => {
            const base = patchAgentMessages(s, startSid, activeAgent, (msgs) =>
              msgs.map((m) => (m.id === userMsg.id ? { ...m, msgId: mid } : m)),
            );
            const tabs = (base.tabs ?? s.tabs).map((t) =>
              t.sid === startSid
                ? { ...t, checkpointMsgIds: { ...t.checkpointMsgIds, [mid]: true } }
                : t,
            );
            return { ...base, tabs };
          });
        }
        // **不**立即 status='done' —— asst bubble 保持 streaming 等 WS 真实事件
        // 喂数据（hook:turnStart / stream:llm chunks / hook:assistantMessage /
        // hook:turnEnd）。providerId 标 'forgeax' 让 ForgeCard 头部 badge 显示
        // 正确来源。session-stream 会在 hook:turnEnd 时把 isStreaming 置回 false
        // + 算 durationMs；agent_crash → status='error'。
        // 如果目标 agent 不发 hook:turnEnd（比如纯 ScriptAgent 没接 conscious 流）
        // 会卡在 streaming → 8s 后 ForgeCard 渲染 SlowHint —— 这种情况下应该用
        // /api/sessions/:sid/abort 或换一个真接 LLM 的 agent。
        patchAsst((m) => ({
          ...m,
          providerId: m.providerId ?? 'forgeax',
        }));
      } catch (err) {
        patchAsst((m) => ({
          ...m,
          status: 'error',
          errorMessage: `forgeax emit failed: ${(err as Error).message}`,
        }));
        setTabStreaming(false);
      }
      _abortByTab.delete(startSid);
      return;
    }

    let res: Response;
    try {
      // 2026-05-20 重做后 sid === threadId === sessionId（一一对应），cli 桥
      // 端的三个字段全部用同一个 sid 传上去，server 那边 legacy 映射保留兼容。
      res = await fetch('/api/cli/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // Expand any ⟦pill:...⟧ sentinels to their full detail before the
          // backend (and downstream AI) see the prompt. The user-bubble keeps
          // the raw sentinel form so replay can re-render chips.
          message: expandPills(trimmed),
          agentId,
          threadId: startSid,
          sessionId: startSid,
          ...(turnOverride ? { providerOverride: turnOverride } : {}),
        }),
        signal,
      });
    } catch (e) {
      // AbortError = 这条被取消/被新一轮顶替(rewind+send、Stop、超发),不是真网络故障。
      // 与下面 SSE 流读取段的 AbortError 处理对齐:静默收尾为 done,别弹「network error:
      // signal is aborted without reason」这种吓人的红字(回退后改发就常命中此路)。
      if ((e as Error).name === 'AbortError' || signal.aborted) {
        patchAsst((m) => (m.status === 'streaming' ? { ...m, status: 'done' } : m));
      } else {
        patchAsst((m) => ({
          ...m,
          status: 'error',
          errorMessage: `network error: ${(e as Error).message}`,
        }));
      }
      setTabStreaming(false);
      _abortByTab.delete(startSid);
      return;
    }

    if (!res.ok) {
      let body: { error?: string; hint?: string } = {};
      try {
        body = await res.json();
      } catch {
        /* ignore */
      }
      patchAsst((m) => ({
        ...m,
        status: 'error',
        errorMessage: body.error
          ? `${res.status} ${body.error}${body.hint ? ` — ${body.hint}` : ''}`
          : `HTTP ${res.status}`,
      }));
      setTabStreaming(false);
      _abortByTab.delete(startSid);
      return;
    }
    if (!res.body) {
      patchAsst((m) => ({ ...m, status: 'error', errorMessage: 'empty response body' }));
      setTabStreaming(false);
      _abortByTab.delete(startSid);
      return;
    }

    // ─────────────────────────────────────────────────────────────────────
    // [STAGE3] SSE → TurnAccumulator → ChatMessage adapter.
    //
    // forgeax-server PR #4 (2026-05-14) changed the SSE wire protocol to
    // emit `event: stored-event` carrying raw EventBus StoredEvent payloads.
    // We consume these via TurnAccumulator (ported from forgeax-cli's
    // ink-renderer in PR-interface #3, lives at src/lib/event-engine/) and
    // adapt the resulting RendererMessage stream back to the legacy
    // ChatMessage shape so ForgeCard keeps working unchanged.
    //
    // Routing: events from the main agent (emitterId ≡ activeAgent / 'main' /
    // 'forgeax' / undefined) feed a single mainAcc that updates asstMsg.
    // Events from subagent emitterIds feed per-emitter accumulators in
    // subAccs, each updating the corresponding entry in asstMsg.subAgents.
    //
    // The legacy parser (verbatim) is preserved in the [STAGE3A:DORMANT]
    // block comment below as a diff reference — to be removed in the
    // follow-up cleanup PR once this path is validated in production.
    // ─────────────────────────────────────────────────────────────────────

    // Live SSE routes events to a main TurnAccumulator (this tab's bound
    // agent) and a lazy per-emitter Map<sid, TurnAccumulator> for sub-agents.
    // Callback bodies live in lib/event-engine/message-builder.ts and are
    // SHARED with the replay path (post-PR #9) — sendMessage and loadSession
    // differ only in how MessageEffects bind. This is what makes live ≡
    // replay rendering parity hold for tool-chip `tc.at` positioning.
    //
    // 'admin' is the cli daemon's default emitter id — when activeAgent is
    // 'forgeax' (the studio instance), admin events ARE main events. Without
    // this alias, forgeax-provider replies would land in a sub-agent slot
    // and ForgeCard would render "(空响应)" because the main message text
    // never gets filled. (Real subagent emitters use distinct ids.)
    const isMain = (eid: unknown): boolean =>
      !eid || eid === agentId || (agentId === 'forgeax' && eid === 'admin');

    const patchSub = (emitterId: string, mut: (r: SubAgentRun) => SubAgentRun) => {
      set((s) =>
        patchTabMessages(s, startSid, (msgs) =>
          msgs.map((m) => {
            if (m.id !== asstMsg.id) return m;
            const subAgents = { ...(m.subAgents ?? {}) };
            const prev: SubAgentRun = subAgents[emitterId] ?? {
              emitterId,
              text: '',
              toolCalls: [],
              status: 'streaming',
              startedAt: Date.now(),
            };
            subAgents[emitterId] = mut(prev);
            return { ...m, subAgents };
          }),
        ),
      );
    };

    // Live effects: patchAsst / patchSub already match MessageEffects shape.
    // onUserInput omitted because sendMessage manually pushed the user
    // bubble + assistant skeleton above (auto-title etc. happens there).
    const liveEffects: MessageEffects = {
      applyMain: patchAsst,
      applySub: patchSub,
    };

    // Main accumulator drives the top-level assistant bubble.
    const mainAcc = new TurnAccumulator(buildMainCallbacks(liveEffects), agentId);

    // Lazy per-subagent accumulators, keyed by emitterId.
    const subAccs = new Map<string, TurnAccumulator>();
    const getSubAcc = (eid: string): TurnAccumulator => {
      const existing = subAccs.get(eid);
      if (existing) return existing;
      const acc = new TurnAccumulator(buildSubCallbacks(eid, liveEffects), eid);
      subAccs.set(eid, acc);
      return acc;
    };

    // Tracks the most recent main-emitter providerId we've seen on any frame.
    // Used on the AbortError path (Stop button) to give the partial-bubble a
    // badge — the per-event handlers already capture into m.providerId, but
    // if the user cancels before any stored-event lands we need a fallback.
    let lastSeenProviderId: string | undefined;
    // providerId only needs committing to the bubble ONCE. The per-frame patchAsst
    // below (every streamed frame carries providerId) was a no-op-but-still-a-
    // `set()` path — ~1 set per frame, another un-throttled synchronous burst
    // contributor alongside token/thinking. Commit once, then skip.
    let mainProviderIdCommitted = false;
    const subProviderIdCommitted = new Set<string>();

    // tool-call-delta throttle: accumulate rapid deltas across frames and
    // flush at most once per 32ms (≈ 30Hz). Prevents 50+ setState/render
    // cycles during a single write_file.
    const sseDeltaBuf = new Map<string, {
      callId: string; name: string; accumulated: string;
      mainEvent: boolean; emitterId: string | null;
    }>();
    let sseLastFlush = 0;
    const SSE_DELTA_INTERVAL = 32;

    const flushSseDeltaBuf = (): void => {
      if (sseDeltaBuf.size === 0) return;
      const batch = [...sseDeltaBuf.values()];
      sseDeltaBuf.clear();
      sseLastFlush = Date.now();
      for (const pd of batch) {
        const applyDelta = (tc: ToolCall): ToolCall => {
          if (tc.callId !== pd.callId) return tc;
          const prev = typeof tc.args === 'string' ? tc.args : '';
          return { ...tc, args: prev + pd.accumulated, status: 'running' };
        };
        if (pd.mainEvent) {
          patchAsst((m) => {
            const existing = m.toolCalls.find((t) => t.callId === pd.callId);
            if (existing) {
              const toolCalls = m.toolCalls.map(applyDelta);
              const segments = (m.segments ?? []).map((s) =>
                s.kind === 'tool' && (s as { tool: ToolCall }).tool.callId === pd.callId
                  ? { ...s, tool: applyDelta((s as { tool: ToolCall }).tool) }
                  : s,
              );
              return { ...m, toolCalls, segments };
            }
            const tc: ToolCall = { callId: pd.callId, name: pd.name, args: pd.accumulated, status: 'running' };
            return {
              ...m,
              toolCalls: [...m.toolCalls, { ...tc, at: m.text.length }],
              segments: upsertToolSegment(m.segments ?? [], Date.now(), tc),
            };
          });
        } else if (pd.emitterId) {
          patchSub(pd.emitterId, (r) => ({ ...r, toolCalls: r.toolCalls.map(applyDelta) }));
        }
      }
    };

    // Throttle token/thinking text exactly like tool-call-deltas. These two were
    // the ONLY un-throttled per-event patchAsst paths left: on a fast/large turn a
    // single network chunk delivers a backlog of token/thinking frames that commit
    // >50 synchronous store sets in one tick → React "Maximum update depth exceeded"
    // at settle (root cause: token + thinking per-event patchAsst counts vs the
    // already-throttled delta path). Buffer consecutive chunks per emitter (ordered,
    // so text↔thinking interleave + ordering vs tool segments is preserved) and
    // commit on the same ~32ms cadence; flush before any non-text event + on finally.
    const sseTextBuf = new Map<string, {
      mainEvent: boolean; emitterId: string | null;
      chunks: Array<{ kind: 'text' | 'thinking'; text: string }>;
      providerId?: string;
    }>();
    let sseTextLastFlush = 0;
    const flushSseTextBuf = (): void => {
      if (sseTextBuf.size === 0) return;
      const batch = [...sseTextBuf.values()];
      sseTextBuf.clear();
      sseTextLastFlush = Date.now();
      for (const b of batch) {
        const ts = Date.now();
        if (b.mainEvent) {
          patchAsst((m) => {
            let segments = m.segments ?? [];
            let text = m.text;
            let thinking = m.thinking ?? '';
            for (const ch of b.chunks) {
              if (ch.kind === 'text') text += ch.text; else thinking += ch.text;
              segments = appendChatSegment(segments, { kind: ch.kind, ts, text: ch.text });
            }
            return { ...m, text, thinking, segments, providerId: m.providerId ?? b.providerId };
          });
        } else if (b.emitterId) {
          patchSub(b.emitterId, (r) => {
            let text = r.text;
            let thinking = r.thinking ?? '';
            for (const ch of b.chunks) { if (ch.kind === 'text') text += ch.text; else thinking += ch.text; }
            return { ...r, text, thinking, providerId: r.providerId ?? b.providerId };
          });
        }
      }
    };
    const bufText = (
      mainEvent: boolean, emitterId: string | null,
      kind: 'text' | 'thinking', text: string, providerId?: string,
    ): void => {
      const key = emitterId ?? '__main__';
      let b = sseTextBuf.get(key);
      if (!b) { b = { mainEvent, emitterId, chunks: [], providerId }; sseTextBuf.set(key, b); }
      b.chunks.push({ kind, text });
      if (providerId && !b.providerId) b.providerId = providerId;
    };

    try {
      for await (const frame of parseSse(res.body)) {
        if (!frame.data) continue;
        // Stage 3 handles `agent-start` (envelope) and `stored-event` (raw
        // StoredEvent payload). Subprocess providers (claude-code / codex /
        // cursor-agent) emit normalized ChatEvent names (`token` / `thinking`
        // / `tool-call` / `tool-result` / `done` / `error`) — handle them
        // inline so the UI doesn't blank-out when forgeax-cli is bypassed.
        if (
          frame.event !== 'agent-start' &&
          frame.event !== 'stored-event' &&
          frame.event !== 'token' &&
          frame.event !== 'thinking' &&
          frame.event !== 'tool-call' &&
          frame.event !== 'tool-call-delta' &&
          frame.event !== 'tool-result' &&
          frame.event !== 'done' &&
          frame.event !== 'error'
        ) {
          continue;
        }

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(frame.data);
        } catch {
          continue;
        }

        const emitterId = payload.emitterId as string | undefined;
        const providerId = payload.providerId as string | undefined;

        // providerId capture — once per (main vs sub-agent) bubble. Mirrors
        // the legacy m.providerId / r.providerId ?? fallback.
        if (providerId) {
          if (isMain(emitterId)) {
            lastSeenProviderId = providerId;
            if (!mainProviderIdCommitted) {
              mainProviderIdCommitted = true;
              patchAsst((m) => (m.providerId ? m : { ...m, providerId }));
            }
          } else if (emitterId && !subProviderIdCommitted.has(emitterId)) {
            subProviderIdCommitted.add(emitterId);
            patchSub(emitterId, (r) => (r.providerId ? r : { ...r, providerId }));
          }
        }

        // threadId / sessionId 字段 R3 之后等价于 sid，一定 === startSid（由
        // server 端回传的 thread/session 跟我们 POST 时塞的 startSid 一致）；
        // 如果某天 server 又下发不同 thread id 那是兼容性问题（说明 server 端
        // 还没切完 R3），这里只做诊断不再 patch tab —— tab 跟 sid 一对一是
        // 不可破的不变量。
        const sentThreadId = typeof payload.threadId === 'string' ? payload.threadId : null;
        if (sentThreadId && sentThreadId !== startSid) {
          console.warn('[sendMessage] server returned threadId !== startSid', { sentThreadId, startSid });
        }
        // runId capture — every frame after Run creation carries `payload.runId`
        // (chat.ts:235). Stash on the tab so cancelStream() can POST a real
        // server-side cancel + a follow-up refresh can still target this Run.
        const sentRunId = typeof payload.runId === 'string' ? payload.runId : null;
        if (sentRunId) {
          set((s) => {
            const tab = s.tabs.find((t) => t.sid === startSid);
            if (!tab || tab.runId === sentRunId) return {};
            return patchTabField(s, startSid, { runId: sentRunId });
          });
        }

        if (frame.event === 'agent-start') {
          // R3 后 sid 是真值源；agent-start.sessionId 应该 === startSid，否则
          // 同样是后端 R3 残留 bug。
          const sid = typeof payload.sessionId === 'string' ? payload.sessionId : null;
          if (sid && sid !== startSid) {
            console.warn('[sendMessage] agent-start sessionId !== startSid', { sid, startSid });
          }
          continue;
        }

        // Subprocess-provider events — claude-code / codex / cursor-agent emit
        // these directly (no StoredEvent wrapping). Route to main bubble when
        // emitterId is undefined/main; otherwise to the per-emitter subagent
        // accumulator (rare for subprocess providers but kept symmetric).
        if (
          frame.event === 'token' ||
          frame.event === 'thinking' ||
          frame.event === 'tool-call' ||
          frame.event === 'tool-call-delta' ||
          frame.event === 'tool-result' ||
          frame.event === 'done' ||
          frame.event === 'error'
        ) {
          const mainEvent = isMain(emitterId);
          const nowTs = Date.now();
          // Any non-text/thinking event must commit buffered text first so its
          // segment lands AFTER the preceding text (ordering vs tool/done).
          if (frame.event !== 'token' && frame.event !== 'thinking') flushSseTextBuf();
          if (frame.event === 'token') {
            const text = String(payload.text ?? '');
            if (text) {
              bufText(mainEvent, emitterId ?? null, 'text', text, providerId);
              if (nowTs - sseTextLastFlush >= SSE_DELTA_INTERVAL) flushSseTextBuf();
            }
          } else if (frame.event === 'thinking') {
            const text = String(payload.text ?? '');
            if (text) {
              bufText(mainEvent, emitterId ?? null, 'thinking', text, providerId);
              if (nowTs - sseTextLastFlush >= SSE_DELTA_INTERVAL) flushSseTextBuf();
            }
          } else if (frame.event === 'tool-call') {
            // P-tool-live (2026-05-17) — was DORMANT for the subprocess path
            // (claude-code/codex/cursor-agent), causing tool chips to never
            // appear in live first-turn until refresh.  Same data shape the
            // legacy parser produced (callId/name/args + status='running'),
            // PLUS a tool segment so segments[]-driven ForgeCard slots it in
            // chronological order with text/thinking.
            const callId = String(payload.callId ?? '');
            if (callId) {
              const tc: ToolCall = {
                callId,
                name: String(payload.name ?? 'tool'),
                args: payload.args ?? {},
                status: 'running',
              };
              if (mainEvent) {
                patchAsst((m) => ({
                  ...m,
                  toolCalls: [...m.toolCalls, { ...tc, at: m.text.length }],
                  segments: upsertToolSegment(m.segments ?? [], nowTs, tc),
                }));
              } else if (emitterId) {
                patchSub(emitterId, (r) => ({ ...r, toolCalls: [...r.toolCalls, tc] }));
              }
            }
          } else if (frame.event === 'tool-call-delta') {
            const callId = String(payload.callId ?? '');
            const delta = typeof payload.argumentsDelta === 'string' ? payload.argumentsDelta : '';
            if (callId && delta) {
              const key = callId;
              const prev = sseDeltaBuf.get(key);
              if (prev) {
                prev.accumulated += delta;
              } else {
                sseDeltaBuf.set(key, {
                  callId,
                  name: String(payload.name ?? 'tool'),
                  accumulated: delta,
                  mainEvent,
                  emitterId: emitterId ?? null,
                });
              }
              if (Date.now() - sseLastFlush >= SSE_DELTA_INTERVAL) flushSseDeltaBuf();
            }
          } else if (frame.event === 'tool-result') {
            flushSseDeltaBuf(); // flush pending deltas before marking done
            const callId = String(payload.callId ?? '');
            const ok = payload.ok !== false;
            const result = typeof payload.result === 'string' ? payload.result : undefined;
            const error = typeof payload.error === 'string' ? payload.error : undefined;
            const apply = (tc: ToolCall): ToolCall =>
              tc.callId !== callId ? tc
                : { ...tc, status: ok ? 'done' : 'error', result, error };
            if (mainEvent) {
              patchAsst((m) => {
                const toolCalls = m.toolCalls.map(apply);
                const segments = (m.segments ?? []).map((s) =>
                  s.kind === 'tool' && (s as { tool: ToolCall }).tool.callId === callId
                    ? { ...s, tool: apply((s as { tool: ToolCall }).tool) }
                    : s,
                );
                return { ...m, toolCalls, segments };
              });
            } else if (emitterId) {
              patchSub(emitterId, (r) => ({ ...r, toolCalls: r.toolCalls.map(apply) }));
            }
          } else if (frame.event === 'error') {
            flushSseDeltaBuf();
            const msg = String(payload.message ?? payload.error ?? 'stream error');
            if (mainEvent) {
              patchAsst((m) => ({ ...m, status: 'error', errorMessage: msg }));
            } else if (emitterId) {
              patchSub(emitterId, (r) => ({ ...r, status: 'error', errorMessage: msg } as SubAgentRun));
            }
          } else if (frame.event === 'done') {
            flushSseDeltaBuf();
          }
          continue;
        }

        // frame.event === 'stored-event' — the SSE writer merges the
        // StoredEvent fields onto the same JSON object as the envelope
        // (agentId / sessionId / threadId / runId), so the payload object
        // itself is a valid StoredEvent. TurnAccumulator only reads .type /
        // .payload / .emitterId / .source / .ts and ignores extras.
        const stored = payload as unknown as StoredEvent;
        const eid = stored.emitterId ?? '';
        const acc = isMain(eid) ? mainAcc : getSubAcc(eid);
        acc.feed(stored);
      }
    } catch (e) {
      // AbortError is the cancelStream() path — finalize the partial bubble
      // gracefully as 'done' rather than an error.
      if ((e as Error).name === 'AbortError' || signal.aborted) {
        patchAsst((m) => ({
          ...m,
          status: 'done',
          providerId: m.providerId ?? lastSeenProviderId ?? turnOverride ?? undefined,
        }));
      } else {
        patchAsst((m) => ({
          ...m,
          status: 'error',
          errorMessage: `stream error: ${(e as Error).message}`,
        }));
      }
    } finally {
      flushSseTextBuf();
      flushSseDeltaBuf();
      // Flush any pending messages out of every accumulator — TurnAccumulator
      // holds the last unsettled turn until flush() commits it.
      mainAcc.flush();
      for (const acc of subAccs.values()) acc.flush();

      // Mark the main bubble done (mirrors legacy's hook:done patch). For
      // sub-agents: their status was already set by their TurnAccumulator's
      // hook:turnEnd handling via onTurn; we sweep any still-streaming ones
      // here as a safety net for premature stream close.
      patchAsst((m) => (m.status === 'streaming' ? { ...m, status: 'done' } : m));
      for (const eid of subAccs.keys()) {
        patchSub(eid, (r) => (r.status === 'streaming' ? { ...r, status: 'done' } : r));
      }

      _abortByTab.delete(startSid);
      setTabStreaming(false);
    }

    /* ─────────────────────────────────────────────────────────────────────
       [STAGE3A:DORMANT] Legacy SSE → ChatMessage pipeline (verbatim copy).

       Active before forgeax-server PR #4 (which introduced raw StoredEvent
       SSE passthrough). Preserved here for Stage 3b implementation diff —
       Stage 3b will replace the cut stub above with a re-wire that pipes
       StoredEvent payloads through TurnAccumulator + per-emitterId
       Map<sid, TurnAccumulator> bucketing, then converts the resulting
       CompletedTurn[] back to ChatMessage[] (compat shim) so ForgeCard
       keeps working until Stage 4 changes its input shape.

       To temporarily revive for testing on an OLD server (pre-PR #4):
       delete the cut stub above and the block-comment fences (lines that
       open and close this comment), leaving the code below in place.
       ─────────────────────────────────────────────────────────────────────

    // Resolve which emitterId is "the parent agent" — events from this
    // emitter go on the main message; events from other emitterIds (e.g.
    // iori, suzu) go into per-subagent cards keyed by emitterId.
    const isMain = (eid: unknown): boolean =>
      !eid || eid === activeAgent || eid === 'main' || eid === 'forgeax';

    const patchSub = (emitterId: string, mut: (r: SubAgentRun) => SubAgentRun) => {
      set((s) => patchTabMessages(s, startTabId, (msgs) => msgs.map((m) => {
        if (m.id !== asstMsg.id) return m;
        const subAgents = { ...(m.subAgents ?? {}) };
        const prev: SubAgentRun = subAgents[emitterId] ?? {
          emitterId, text: '', toolCalls: [], status: 'streaming', startedAt: Date.now(),
        };
        subAgents[emitterId] = mut(prev);
        return { ...m, subAgents };
      })));
    };

    // Tracks the most recent main-emitter providerId we've seen on any SSE
    // event. Used on the AbortError path (Stop button or stream-error) to
    // ensure the partial-bubble still gets its badge — the per-event handlers
    // already capture into m.providerId, but if the user cancels before any
    // token arrives we need a fallback that lives outside the for-await loop.
    let lastSeenProviderId: string | undefined;
    try {
      for await (const frame of parseSse(res.body)) {
        if (!frame.data) continue;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(frame.data);
        } catch {
          continue;
        }
        const emitterId = payload.emitterId as string | undefined;
        const providerId = payload.providerId as string | undefined;
        if (providerId && isMain(emitterId)) lastSeenProviderId = providerId;
        const mainEvent = isMain(emitterId);

        // P6b: capture threadId once per turn so reload-restore knows where
        // to fetch this tab's history. chat.ts shim attaches threadId/runId
        // to every payload after Run creation.
        const sentThreadId = typeof payload.threadId === 'string' ? payload.threadId : null;
        if (sentThreadId) {
          set((s) => {
            const tab = s.tabs.find((t) => t.id === startTabId);
            if (!tab || tab.threadId === sentThreadId) return {};
            const next = patchTabField(s, startTabId, { threadId: sentThreadId });
            const tabs = next.tabs ?? s.tabs;
            persistTabs(tabs, s.activeTabId);
            return next;
          });
        }
        // runId capture — parallel to threadId.  Lets cancelStream POST a
        // server-side cancel that actually halts the cli subprocess.
        const sentRunId = typeof payload.runId === 'string' ? payload.runId : null;
        if (sentRunId) {
          set((s) => {
            const tab = s.tabs.find((t) => t.id === startTabId);
            if (!tab || tab.runId === sentRunId) return {};
            const next = patchTabField(s, startTabId, { runId: sentRunId });
            const tabs = next.tabs ?? s.tabs;
            persistTabs(tabs, s.activeTabId);
            return next;
          });
        }
        switch (frame.event) {
          case 'agent-start': {
            // Server echoes the resolved sessionId. Save into the *tab* so
            // the next message in that tab threads onto the same session
            // — even if the user switched tabs.
            const sid = typeof payload.sessionId === 'string' ? payload.sessionId : null;
            if (sid) {
              set((s) => {
                const cur = s.tabs.find((t) => t.id === startTabId);
                if (!cur || cur.sessionId === sid) return {};
                const next = patchTabField(s, startTabId, { sessionId: sid });
                const tabs = next.tabs ?? s.tabs;
                persistTabs(tabs, s.activeTabId);
                return next;
              });
            }
            break;
          }
          case 'token': {
            const incoming = String(payload.text ?? '');
            if (!incoming) break;
            if (mainEvent) {
              patchAsst((m) => {
                const needSep = m.text.length > 0 && !m.text.endsWith('\n\n');
                return {
                  ...m,
                  text: m.text + (needSep ? '\n\n' : '') + incoming,
                  providerId: m.providerId ?? providerId,
                };
              });
            } else if (emitterId) {
              patchSub(emitterId, (r) => ({ ...r, text: r.text + incoming, providerId: r.providerId ?? providerId }));
            }
            break;
          }
          case 'thinking':
            if (mainEvent) {
              patchAsst((m) => ({ ...m, thinking: (m.thinking ?? '') + String(payload.text ?? '') }));
            } else if (emitterId) {
              patchSub(emitterId, (r) => ({ ...r, thinking: (r.thinking ?? '') + String(payload.text ?? '') }));
            }
            break;
          case 'tool-call': {
            const tc: ToolCall = {
              callId: String(payload.callId ?? ''),
              name: String(payload.name ?? 'tool'),
              args: payload.args ?? {},
              status: 'running',
            };
            if (mainEvent) {
              patchAsst((m) => ({ ...m, toolCalls: [...m.toolCalls, { ...tc, at: m.text.length }] }));
            } else if (emitterId) {
              patchSub(emitterId, (r) => ({ ...r, toolCalls: [...r.toolCalls, tc] }));
            }
            break;
          }
          case 'tool-call-delta': {
            const callId = String(payload.callId ?? '');
            const delta = typeof payload.argumentsDelta === 'string' ? payload.argumentsDelta : '';
            if (callId && delta) {
              const key = callId;
              const prev = sseDeltaBuf.get(key);
              if (prev) {
                prev.accumulated += delta;
              } else {
                sseDeltaBuf.set(key, {
                  callId,
                  name: String(payload.name ?? 'tool'),
                  accumulated: delta,
                  mainEvent,
                  emitterId: emitterId ?? null,
                });
              }
              if (Date.now() - sseLastFlush >= SSE_DELTA_INTERVAL) flushSseDeltaBuf();
            }
            break;
          }
          case 'tool-result': {
            flushSseDeltaBuf();
            const update = (tc: ToolCall): ToolCall => (
              tc.callId === payload.callId
                ? {
                    ...tc,
                    status: payload.ok === false ? 'error' : 'done',
                    result: typeof payload.result === 'string' ? payload.result : undefined,
                    error: typeof payload.error === 'string' ? payload.error : undefined,
                  }
                : tc
            );
            if (mainEvent) {
              patchAsst((m) => ({ ...m, toolCalls: m.toolCalls.map(update) }));
            } else if (emitterId) {
              patchSub(emitterId, (r) => ({ ...r, toolCalls: r.toolCalls.map(update) }));
            }
            break;
          }
          case 'done': {
            const cost = typeof payload.cost === 'number' ? payload.cost : undefined;
            const durationMs = typeof payload.durationMs === 'number' ? payload.durationMs : undefined;
            if (mainEvent) {
              patchAsst((m) => ({
                ...m,
                status: 'done',
                // Silent-done turns (forgeax cli's empty-content path) never
                // hit the token handler, so providerId would otherwise stay
                // undefined and the badge wouldn't render. Fall back to the
                // done event's providerId in that case.
                providerId: m.providerId ?? providerId,
                ...(cost !== undefined ? { cost } : {}),
                ...(durationMs !== undefined ? { durationMs } : {}),
              }));
            } else if (emitterId) {
              patchSub(emitterId, (r) => ({ ...r, status: 'done', providerId: r.providerId ?? providerId }));
            }
            break;
          }
          case 'error':
            if (mainEvent) {
              patchAsst((m) => ({
                ...m,
                status: 'error',
                errorMessage: String(payload.message ?? 'unknown error'),
                // Capture providerId on error too — a 0-token error path
                // (e.g. provider DOWN, prefix-matched but unhealthy) would
                // otherwise leave the bubble badge-less. Mirrors the
                // tick 105 fix for 'done'.
                providerId: m.providerId ?? providerId,
              }));
            } else if (emitterId) {
              patchSub(emitterId, (r) => ({ ...r, status: 'error', providerId: r.providerId ?? providerId }));
            }
            break;
        }
      }
    } catch (e) {
      // AbortError is the cancelStream() path — finalize the partial bubble
      // gracefully as 'done' rather than an error.
      if ((e as Error).name === 'AbortError' || signal.aborted) {
        // Triple fallback for providerId on the cancel path:
        //   1. m.providerId — captured from token/done/error events that DID arrive
        //   2. lastSeenProviderId — closure-tracked from any main-emitter event
        //   3. turnOverride — the explicit override the user picked when sending
        // Only #1 + #2 cover the post-event-arrival cancel; #3 catches the
        // "Stop within first 2s, before any provider-tagged event lands" race.
        patchAsst((m) => ({
          ...m,
          status: 'done',
          providerId: m.providerId ?? lastSeenProviderId ?? turnOverride ?? undefined,
        }));
      } else {
        patchAsst((m) => ({
          ...m,
          status: 'error',
          errorMessage: `stream error: ${(e as Error).message}`,
        }));
      }
    } finally {
      _abortByTab.delete(startTabId);
      setTabStreaming(false);
    }

    ─────────────────────────────────────────────────────────────────────
    */
  },
})));


