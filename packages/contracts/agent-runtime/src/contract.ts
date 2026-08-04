/**
 * AgentKernel contract — the neutral spine the orchestration layer
 * programs against. This is the M1 linchpin of forgeax_os: the
 * orchestration layer (`packages/server/src/core/`) imports ONLY this
 * module, so everything kernel-specific (the agent SDK, the tool-use gate,
 * resume, the streamed-message type, the permission-mode enum) stays locked
 * inside `packages/server/src/kernel/` and never leaks into the spine.
 *
 *   first kernel  = BcKernel           (M2, hidden behind this contract)
 *   second kernel = forgeax-core       (P7, a drop-in slot implementation)
 *
 * Hard rule (boundary lint Rule6, re-added in M3): this file imports NO
 * kernel-isms and NO `@anthropic-ai/*`. The kernel-shaped vocabulary
 * (the native default/acceptEdits/plan/bypass permission enum) lives in
 * the kernel's profile adapter, NOT here (B2 layering). The spine speaks
 * only neutral `PermissionMode` words.
 *
 * Discriminant is `kind:` (inherited from this package's Driver.ChatEvent,
 * the "C1 lock-in shape") — NOT the CliProvider `type:`. The one-time
 * `type:` → `kind:` translation happens in the inbound mapper (M2) and the
 * `kind:` → wire `event:` translation in `toWireEvents` (M5/M3).
 *
 * ─── three-contract reconciliation (设计稿 §1.2, lossless) ─────────────
 * KernelEvent is the supremum (上确界) of the three pre-existing event
 * contracts. Four fields are easy to drop in a re-platform and are each
 * named here so a mapper that omits one fails review:
 *
 *   semantic        CliProvider(type:)   Driver(kind:)   → KernelEvent
 *   text delta      token                token           message.delta
 *   thinking        thinking             (MISSING)       thinking.delta   ← Driver lacked it
 *   tool call       tool-call            tool-call       tool.call
 *   tool args flow  tool-call-delta      (MISSING)       tool.call.delta  ← UI depends on it
 *   tool result     tool-result{ok,err}  tool-result     tool.result{ok,error}
 *   usage           done.usage.cache*    usage{p/c}      turn.usage       ← MUST keep cache tokens
 *   cost/duration   done.{cost,durMs}    —               turn.usage.{costUsd,durationMs}
 *   stop reason     done.stopReason      done.reason     turn.done.reason
 *   error           error{message,code}  error{msg,rec}  error.error (KernelError)
 *   native pass-thru stored-event        —               stored-event     ← forgeax path, rented kernels never emit
 *
 * The wire field renames (`argsDelta→argumentsDelta`, `payload→storedEvent`,
 * `cacheRead→cacheReadTokens`, independent `turn.usage` folded back into
 * `done.usage`) are NOT done here — they happen in `toWireEvents` (§1.2.1)
 * and are guarded by a golden wire snapshot, because the `default: never`
 * exhaustiveness guard only proves `kind` coverage, not payload fidelity.
 */

// ─── identity & capabilities ─────────────────────────────────────────

/** Known kernel ids. Widened with `(string & {})` so future slots and the
 *  test-only NoopKernel ('noop') type-check without editing the spine. */
export type KernelId = 'bc' | 'forgeax-core' | (string & {});

export interface KernelCapabilities {
  /** Streams partial assistant text (`message.delta`). */
  streaming: boolean;
  /** Emits `thinking.delta` reasoning chunks. */
  thinking: boolean;
  /** Supports tool calls (`tool.call` / `tool.result`). */
  toolCalls: boolean;
  /** Can inject context mid-turn. Rented kernels = false (only between-turn L1 +
   *  veto-only L2 at the tool boundary; see 设计稿 §1.3 L2 既定仅否决式). */
  midTurnInject: boolean;
  /** Can perform a **cache-safe fork extraction**: re-issue this turn's request
   *  to itself with the prompt-cache prefix (system+tools+messages) reused and a
   *  single appended instruction, so background memory extraction rides cache-read.
   *  Drives the orchestration layer's cache-warm-vs-cold-fallback choice and the
   *  Studio "saves tokens?" tip. Native forgeax-core = true (runForkedAgent);
   *  claude-code = true (its own extractMemories fork); codex/rented w/o a fork
   *  primitive = false (orchestration falls back to a cold extraction, §9).
   *  Absent in older kernels ⇒ treat as false. Additive (frozen-allowed). */
  forkExtract: boolean;
}

// ─── turn inputs ─────────────────────────────────────────────────────

/** Which conversation + which agent persona this turn belongs to.
 *  Converged from CliProvider.ChatRequest. Note `threadId ≠ the kernel's
 *  session id` — the kernel maintains that mapping internally and uses its
 *  own id for resume (协议级真相 ⚠1). */
export interface SessionRef {
  threadId: string;
  agentId: string;
}

export interface InputMessage {
  text: string;
  /** Structured attachments — image refs, files, etc. The shape stays
   *  open; kernels MUST tolerate unknown keys (forward-compat). */
  attachments?: Array<Record<string, unknown>>;
}

/** A neutral conversation message for HOST-OWNED context (`TurnRequest.history`).
 *  Mirrors the shape the orchestration layer's `materialize*` already produces,
 *  kept neutral (no llm-lib import) so the spine stays dependency-free. Tool
 *  results carry their FULL payload so the host's ledger is a faithful, replayable
 *  context source — not just a display projection. See
 *  `历史归属与上下文所有权-取舍方案.md`. */
export type TurnMessage =
  | { role: 'user'; content: string | Array<Record<string, unknown>> }
  | {
      role: 'assistant';
      content: string | Array<Record<string, unknown>>;
      toolCalls?: Array<{ callId: string; name: string; args?: unknown }>;
    }
  | { role: 'tool'; callId: string; ok: boolean; result?: unknown; error?: string };

export interface HistoryCursor {
  shard: number;
  line: number;
  eventId: string;
}

export type HistoryIntake =
  | { kind: 'structured'; nativeResume: false }
  | { kind: 'text-bridge'; nativeResume: true };

export interface PreparedHistory {
  mode: 'none' | 'snapshot' | 'delta' | 'authoritative';
  messages: TurnMessage[];
  patchId: string;
  laneId?: string;
  epoch?: number;
  through?: HistoryCursor;
  estimatedTokens: number;
  redactedParts: number;
}

/** prompt assembly (设计稿 §2.4, bound to prompt-cache B): `charter`+`persona`
 *  form the stable cached prefix; `dynamicSuffix` (active-game note / L1
 *  perception) is injected as a USER-message suffix, never into the system
 *  prompt, so swapping the active game never busts the prefix cache. */
export interface ComposedPrompt {
  charter: string;
  persona: string;
  dynamicSuffix?: string;
  /** How the kernel applies `charter`+`persona` to its system prompt.
   *  'append' (default) keeps the kernel's built-in identity and appends to it;
   *  'replace' fully replaces the kernel default with `charter`+`persona`.
   *  Opaque to the spine; the profile adapter maps it. Absent ⇒ append
   *  (backward-compatible). Kernels without a replace primitive ignore it. */
  mode?: 'append' | 'replace';
}

/** A tool offered to the kernel. Dual delivery: a rented kernel exposes these
 *  as an MCP server; a native core kernel registers them directly. Shape stays
 *  open for forward-compat. */
export interface ToolSpec {
  name: string;
  /** Runtime capability identity; adapters must preserve it when projecting. */
  capabilityId?: string;
  /** Immutable capability catalog generation used for this turn. */
  capabilityGeneration?: number;
  description?: string;
  /** JSON-schema-ish input contract. Opaque to the spine. */
  inputSchema?: Record<string, unknown>;
  /** 工具执行位置(由 host 决定;权限策略归 host):
   *  - `'host'`(缺省):内核把该工具调用回调宿主执行(host 把闸 + 真实现)。等于现状,作兜底。
   *  - `'local'`:原生 core 内核**在本进程内**用自带 builtin 实现直跑(满速 + crash 隔离)。
   *    host 仅对它信任放行的「安全类」工具(读/写/编辑文件、grep/glob)标 `'local'`;危险类
   *    (bash/出网/删/凭据)仍标 `'host'` 回宿主把闸(ask)。
   *  spine 不解释语义,内核 facade 据此分流;缺省 `'host'` 保向后兼容。 */
  delivery?: 'local' | 'host';
}

/** Live host-owned turn state requested by a native sidecar immediately before
 * each provider call. `knownToolsRevision` lets the host omit an unchanged
 * schema payload while still refreshing the small dynamic prompt suffix. */
export interface HostTurnSnapshotRequest {
  callId: string;
  knownToolsRevision?: string;
}

export interface HostTurnSnapshotResponse {
  toolsRevision: string;
  /** Absent when `toolsRevision === knownToolsRevision`. */
  tools?: ToolSpec[];
  /** Current uncached host context (todos, deferred-tool manifest, etc.). */
  dynamicSuffix?: string;
}

export type HostTurnSnapshotProvider = (
  request: HostTurnSnapshotRequest,
) => Promise<HostTurnSnapshotResponse>;

export interface Budget {
  maxTurns?: number;
  maxTokens?: number;
  deadlineMs?: number;
  maxBudgetUsd?: number;
}

/** Opaque model identifier. The orchestration layer cascades models
 *  (cheap→Opus); the kernel passes it through and does NOT interpret it. */
export type ModelRef = string;

/** Trust tier of the agent pack, assigned authoritatively by load PATH in
 *  `agents/loader.ts` (NOT self-reported by the pack). builtin/Forge =
 *  'own'; marketplace + user-imported = 'imported'. The spine carries it
 *  as an opaque pass-through (additive, frozen-allowed; wired end-to-end in
 *  M7) — the kernel never interprets trust semantics; enforcement lives in
 *  the host (sidecar + checkTool). */
export type TrustTier = 'own' | 'imported';

export interface TurnRequest {
  session: SessionRef;
  /** Optional caller-supplied correlation id (body.callId). Lets the host
   *  match an in-flight turn to a `TurnHandle` for interrupt/cancel. */
  callId?: string;
  input: InputMessage;
  /** Host-owned full conversation history (incl. tool_use/tool_result structure).
   *  Provided when the orchestration layer wants to OWN context instead of relying
   *  on the kernel's own session continuation. RENTED kernels ignore it and use
   *  their own session store (codex via `exec resume`);
   *  the NATIVE forgeax-core kernel CONSUMES it as the authoritative context.
   *  Absent ⇒ kernel falls back to its own continuation (backward-compatible).
   *  Additive (frozen-allowed). See 历史归属与上下文所有权-取舍方案.md. */
  history?: TurnMessage[];
  /** Host decision that produced `history`; kernels must not reinterpret it. */
  historyPlan?: PreparedHistory;
  systemPrompt: ComposedPrompt;
  /** Dual-delivered tools (see ToolSpec). */
  tools: ToolSpec[];
  /** Revision of the bootstrap tool snapshot. Native sidecars use it to avoid
   * retransmitting unchanged schemas during a live turn. */
  toolsRevision?: string;
  /** Capability snapshot generation frozen at turn assembly time. */
  capabilityGeneration?: number;
  /** Require the native sidecar to refresh host-owned tools/context before
   * provider calls. Hosts must capability-check this mode before dispatch. */
  liveHostContext?: boolean;
  /** Tool-surface policy. Carries OPAQUE kernel-native tool names (e.g.
   *  Bash/Read/Edit/Write/Glob/Grep/WebFetch/Task/…); the spine forwards them
   *  verbatim and does NOT interpret them (same contract as `model: ModelRef`).
   *  `allow` = exclusive whitelist of built-in tools the agent may use
   *  (absent ⇒ kernel default = all); `deny` = removed from the model's context
   *  (a bare name like 'Bash', or a wildcard like 'mcp__*'). The profile adapter
   *  maps these onto the kernel's flags; kernels without per-tool control no-op.
   *  Additive (frozen-allowed). */
  toolPolicy?: { allow?: string[]; deny?: string[] };
  budget: Budget;
  /** Orchestration-layer model cascade; pass-through, not interpreted. */
  model?: ModelRef;
  /** Fallback model chain tried in order when `model` is overloaded/unavailable.
   *  Pass-through, not interpreted by the spine.
   *  Absent/empty ⇒ no fallback. Additive (frozen-allowed). */
  fallbackModels?: ModelRef[];
  /** Initial permission mode for THIS turn (neutral enum). The native kernel maps
   *  it via its profile adapter; lets the host start a turn in e.g. `planning`
   *  without a separate `setPermissionMode` control-plane round-trip. Absent ⇒
   *  kernel keeps its current/default mode. Additive (frozen-allowed). */
  permissionMode?: PermissionMode;
  /** Pack trust tier; pass-through to the host enforcement layer (M7). */
  trustTier?: TrustTier;
  /** Host session id (real sid), pass-through for the host-tool bridge: lets a
   *  tool MCP server call back into the host and locate the live agent by
   *  (sid, agentId). Distinct from `session.threadId` (which the kernel maps to
   *  its own CLI session id, often a synthetic UUID). Opaque to the kernel
   *  except for forwarding into the tool server's env. */
  hostSessionId?: string;
  /** W3C `traceparent` (`00-<traceId>-<spanId>-<flags>`) of the caller's span, for
   *  full-chain distributed tracing: the kernel parents its `kernel.turn` span under
   *  this so browser → host → kernel → agent → tool form ONE trace. Opaque pass-through;
   *  absent ⇒ kernel.turn starts its own root (backward-compatible). Additive (frozen-allowed). */
  traceparent?: string;
  /** Blocking gate (the single tool-use chokepoint, fail-closed).
   *  Absent ⇒ kernel applies its own default. */
  requestPermission?(call: PermissionCall): Promise<PermissionDecision>;
  /** Fire-and-forget lifecycle injection (PreToolUse/PostToolUse/turnEnd). */
  hooks?: HookEndpoint;
  /** Memory autonomy switch (auto-memory ownership). When the orchestration layer
   *  owns memory (e.g. the soul / digital-life engine grows layered memory itself),
   *  it sets `false` so the kernel does NOT run its own autonomous auto-memory
   *  (no self-directed extract-to-its-own-store) — preventing double extraction,
   *  duplicate cost, and two conflicting sources of truth. The kernel's fork-extract
   *  MECHANISM stays available to be DRIVEN by the orchestration layer (it is not a
   *  memory write of the kernel's own volition). Absent ⇒ kernel keeps its own
   *  default (backward-compatible; native forgeax-core has no autonomous memory).
   *  Additive (frozen-allowed). */
  memoryAutonomy?: boolean;
}

// ─── permission gate ─────────────────────────────────────────────────

export interface PermissionCall {
  name: string;
  args: unknown;
  /** Correlates to the emitted `tool.call.callId`. */
  callId?: string;
  /** The kernel's tool-use id, when the underlying kernel surfaces one. */
  toolUseId?: string;
  /** Kernel-supplied edit suggestions; opaque to the gate. */
  suggestions?: unknown;
}

export type PermissionDecision =
  | { behavior: 'allow'; updatedArgs?: unknown }
  | { behavior: 'deny'; message: string };

/** Neutral permission modes. The kernel's profile adapter maps these onto
 *  the kernel's native permission enum — the spine stays free of kernel-native
 *  vocabulary (B2):
 *    gated        → every tool gated (native 'default')
 *    autoEdits    → auto-approve edits (native 'acceptEdits')
 *    planning     → plan only, no execution (native 'plan')
 *    unrestricted → bypass the gate (native 'bypassPermissions') */
export type PermissionMode = 'gated' | 'autoEdits' | 'planning' | 'unrestricted';

// ─── hooks (fire-and-forget) ─────────────────────────────────────────

export interface HookEndpoint {
  preToolUse?(call: PermissionCall): void | Promise<void>;
  postToolUse?(call: PermissionCall, result: { ok: boolean; result?: unknown; error?: string }): void | Promise<void>;
  turnEnd?(summary: { reason: TurnDoneReason }): void | Promise<void>;
}

// ─── streamed events ─────────────────────────────────────────────────

export type TurnDoneReason =
  | 'stop'
  | 'tool_use'
  | 'max_tokens'
  | 'max_turns'
  | 'cancelled'
  | 'error';

/** The streamed event union. The trailing `x.*` extensions are
 *  injected by the orchestration layer and DROPPED by the rented-kernel exporter
 *  (they have no native representation). */
export type KernelEvent =
  | { kind: 'message.delta'; role: 'assistant'; text: string }
  | { kind: 'thinking.delta'; text: string }
  | { kind: 'tool.call'; callId: string; name: string; args: unknown }
  | { kind: 'tool.call.delta'; callId: string; name: string; argsDelta: string }
  | { kind: 'tool.result'; callId: string; ok: boolean; result?: unknown; error?: string }
  | {
      kind: 'turn.usage';
      inputTokens?: number;
      outputTokens?: number;
      cacheRead?: number;
      cacheCreation?: number;
      costUsd?: number;
      durationMs?: number;
    }
  | { kind: 'turn.done'; reason: TurnDoneReason }
  | { kind: 'error'; error: KernelError }
  | { kind: 'stored-event'; payload: Record<string, unknown> }
  // ─── observability (T5, additive; native kernels may emit, hosts that don't
  //     recognize the kind simply ignore it — no wire rename in toWireEvents) ───
  /** Context compaction just occurred. `preTokens`/`postTokens` are estimated
   *  conversation-token counts before/after the compaction; `trigger` names why it
   *  fired (e.g. 'auto' / 'manual' / 'pre-message'); `coveredFrom`/`coveredTo` are
   *  the compacted message range (conversation indices). Token fields are optional
   *  (a kernel that cannot estimate them omits them). */
  | {
      kind: 'compact_boundary';
      trigger?: string;
      preTokens?: number;
      postTokens?: number;
      coveredFrom: number;
      coveredTo: number;
    }
  /** An upstream API call is about to be retried. `attempt` is the 1-based number
   *  of the attempt that just failed (the retry is attempt+1); `reason` names the
   *  cause (e.g. '429' / '529' / '500' / 'overloaded' / 'stream_idle');
   *  `retryAfterMs` is the server-advised backoff when present. */
  | { kind: 'api_retry'; attempt: number; reason: string; retryAfterMs?: number }
  // forgeax extensions (orchestration-injected; rented-kernel exporter discards):
  | { kind: 'x.delegation'; delegator: string; agentId: string; brief: string }
  | { kind: 'x.file_activity'; path: string; op: 'write' | 'read' | 'create' }
  | { kind: 'x.perception'; source: 'world' | 'screen' | 'console' | 'playtest'; payload: unknown }
  | { kind: 'x.subagent.start'; agentId: string; agentType?: string; role?: string; depth: number }
  | { kind: 'x.subagent.turn'; agentId: string; turn: number }
  | { kind: 'x.subagent.tool'; agentId: string; callId: string; name: string }
  | { kind: 'x.subagent.done'; agentId: string; reason: string; turns: number; toolCalls: number };

/** All `kind` literals of KernelEvent, kept in sync with the union by a
 *  compile-time exhaustiveness check in the test suite (and by
 *  `toWireEvents`' `default: never` guard in M3). */
export type KernelEventKind = KernelEvent['kind'];

/** Closed error union — replaces Driver's `{message,recoverable}` and
 *  CliProvider's `{message,code?}`. A missing kernel is an explicit `error`
 *  event with `kernel_unavailable`, NOT a silent NoopKernel fallback
 *  (v9 decision #6 / M5). */
export type KernelError =
  | { code: 'kernel_unavailable'; message: string }
  | { code: 'tool_failed'; message: string; retryable: boolean }
  | { code: 'budget_exceeded'; message: string }
  | { code: 'driver_timeout'; message: string }
  | { code: 'cancelled'; message: string }
  | { code: 'protocol'; message: string };

// ─── kernel slot ─────────────────────────────────────────────────────

export interface KernelHealth {
  ok: boolean;
  kernelId: KernelId;
  /** Free-form detail for the SettingsPanel row. */
  detail?: string;
}

/** Active-turn control handle. The neutral face only — `setModel`,
 *  `interrupt`, `cancel`. `setPermissionMode` takes the NEUTRAL
 *  `PermissionMode`; the kernel's profile adapter translates it to the kernel's
 *  native enum. (B2: the spine never names native permission modes.) */
export interface TurnHandle {
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model: ModelRef): Promise<void>;
  /** Turn-level graceful interrupt (kernel interrupt). */
  interrupt(): Promise<void>;
  /** Call-level cancel (= the existing cancelWithDeadline wrapper). */
  cancel(): Promise<void>;
}

// ─── model catalog (optional capability) ─────────────────────────────
//
// Which models a kernel can run is the KERNEL's truth, not the orchestration
// layer's. Two optional members on AgentKernel express it; the orchestration
// resolver (cli `kernel/model-catalog.ts`) falls through: env override →
// listModels() → last-known disk cache → fallbackModels → empty ('none').
// Every kernel that can really ask its backend implements listModels —
// uniformly, whatever the transport (CLI flag, stream-json control protocol,
// JSON-RPC, HTTP). All additive (frozen-allowed, same posture as `forkExtract?`).

/** One model a kernel advertises. `id` is the kernel-native model id the
 *  orchestration layer passes back verbatim via `TurnRequest.model`. */
export interface KernelModelInfo {
  id: string;
  label?: string;
  reasoning?: boolean;
  /** Input modalities, e.g. ['text','image']. */
  input?: string[];
  contextWindow?: number;
}

/** Result of model-catalog resolution. `source` reports WHICH fallback tier
 *  produced the list, honestly — UI renders a badge / empty state from it. */
export interface KernelModelCatalog {
  models: KernelModelInfo[];
  source: 'env' | 'kernel' | 'last-known' | 'static' | 'none';
  /** Upstream failure detail, kept even when a lower tier succeeded
   *  (degradation is visible, not silent — §9). */
  error?: string;
}

/** Kernel-native capability discovery, parallel to listModels().
 * Shared host capabilities are supplied by the orchestration catalog; this
 * protocol is only for the tools/MCP/plugins/commands owned by the kernel. */
export type KernelNativeCapabilityKind = 'mcp' | 'skill' | 'plugin' | 'command';

export interface KernelNativeCapability {
  kind: KernelNativeCapabilityKind;
  id: string;
  label?: string;
  description?: string;
  version?: string;
}

export interface KernelCapabilityCatalog {
  kernelId: KernelId;
  capabilities: KernelNativeCapability[];
  error?: string;
}

/** The single slot the orchestration layer programs against. One
 *  implementation in phase 1 (BcKernel); forgeax-core is the
 *  second slot (P7). Swapping kernels swaps only this implementation —
 *  the orchestration layer changes zero lines. */
export interface AgentKernel {
  readonly id: KernelId;
  readonly capabilities: KernelCapabilities;
  /** Human-facing name for picker rows / driver labels. Absent ⇒ UI shows `id`. */
  readonly displayName?: string;
  /** Run one turn. `usage` MUST be emitted before `turn.done`, including on
   *  cancelled/error paths (best-effort fields), so budget/cascade
   *  accounting never drops a turn (B5). */
  runTurn(req: TurnRequest, signal: AbortSignal): AsyncIterable<KernelEvent>;
  /** Control handle for the in-flight turn identified by `callId`. */
  openHandle(callId: string): TurnHandle;
  /** Readiness probe (= the converged Driver.health / CliProvider.health). */
  probe(): Promise<KernelHealth>;
  /** Optional one-shot init (reuses this package's bootDriver semantics). */
  init?(): Promise<void>;
  /** Optional teardown — kernels holding subprocess/sidecar handles release
   *  them here. */
  shutdown?(): Promise<void>;
  /** Optional **cache-safe fork extraction** (capability `forkExtract`). The
   *  orchestration layer (e.g. the soul / digital-life engine) drives a background
   *  memory-extraction pass that REUSES this turn's prompt-cache prefix: the kernel
   *  re-issues the same system+tools+history with a single appended instruction,
   *  so the extraction rides cache-read. Tool execution is gated to `allowedTools`
   *  (memory-write tools only) — the tool LIST stays identical to keep the cache
   *  key intact. Returns what the fork did (no main-loop events emitted; the fork
   *  does not pollute the conversation transcript). Absent ⇒ the orchestration layer
   *  falls back to its own cold extraction (§9 graceful degradation). */
  forkExtract?(req: ForkExtractRequest, signal: AbortSignal): Promise<ForkExtractResult>;
  /** Optional model-catalog discovery — the kernel OWNS how (spawn its CLI,
   *  speak its control protocol / RPC, call its API, delegate to the gateway).
   *  Absent ⇒ the orchestration resolver falls back to last-known cache →
   *  `fallbackModels` → empty (§9 graceful degradation). */
  listModels?(signal?: AbortSignal): Promise<KernelModelCatalog>;
  /** Optional native capability discovery. */
  listCapabilities?(signal?: AbortSignal): Promise<KernelCapabilityCatalog>;
  /** Optional kernel-author-declared static fallback ids (the LAST resort
   *  before the empty state). This is the kernel's explicit claim, not the
   *  platform guessing — keep it out of orchestration/commands layers. */
  readonly fallbackModels?: string[];
  /** Optional **stateful subagent resume** (capability `subagentResume`). A prior
   *  `runTurn` may have dispatched a subagent that persisted its transcript to the
   *  kernel's append-only event store, surfacing a stable `agentId` (carried on the
   *  `x.subagent.*` events). This re-opens that subagent BY THAT id: the kernel folds
   *  the persisted transcript back into context and continues it with `prompt`, so the
   *  resumed worker sees its prior history. Streams the resumed run as `KernelEvent`s
   *  (the subagent's `x.subagent.*` lifecycle + a final `message.delta` result +
   *  `turn.usage`/`turn.done`). Aligned with the event-log APPEND model (OpenAI Agents
   *  SDK Sessions: get/add) — a resume APPENDS a new turn to the same log, it does NOT
   *  restore a state snapshot, so the store stays the single source of truth (SSOT).
   *  Absent ⇒ the kernel keeps subagents in-memory only (no addressable resume); a
   *  host requiring resume must configure a persistent subagent store. Additive
   *  (frozen-allowed). */
  resumeSubagent?(agentId: string, prompt: string, signal: AbortSignal): AsyncIterable<KernelEvent>;
}

/** Input for `AgentKernel.forkExtract`. Mirrors the cache-relevant fields of the
 *  prior `TurnRequest` (systemPrompt + tools + history) so the fork reproduces the
 *  cached prefix; `instruction` is the single appended user message; `allowedTools`
 *  whitelists which tool names the fork may actually invoke. */
export interface ForkExtractRequest {
  session: SessionRef;
  /** Same systemPrompt (charter+persona) as the prior turn → matching cache prefix. */
  systemPrompt: ComposedPrompt;
  /** Post-turn conversation history (the cached prefix to reuse). */
  history?: TurnMessage[];
  /** Same tools as the prior turn (tools are part of the cache key — keep identical). */
  tools: ToolSpec[];
  model?: ModelRef;
  /** The single appended user instruction (the extraction prompt). */
  instruction: string;
  /** Whitelist of tool names the fork may execute (e.g. the memory-write tools).
   *  Others are denied at call time without changing the advertised tool list. */
  allowedTools: string[];
  hostSessionId?: string;
}

export interface ForkExtractResult {
  ok: boolean;
  /** Number of (allowed) tool invocations the fork made — a proxy for "memories written". */
  toolCalls: number;
  /** file_path values of any Write/Edit the fork performed (flat-file kernels). */
  writtenPaths: string[];
}

// ─── in-process kernel registry ──────────────────────────────────────
// Mirrors the driver registry in `./driver` (落点决议: 复用 registry +
// bootDriver 语义). `resolve-kernel.ts` (M5) builds kernel selection on top
// of these primitives. A missing kernel is surfaced as an explicit
// KernelError by the resolver, never as a silent NoopKernel.

interface KernelSlot {
  kernel: AgentKernel;
  /** When `init()` rejects, the slot is retained so the UI can paint a red
   *  badge; routing must consult `isKernelBroken` before dispatching. */
  brokenReason?: string;
}

const _kernels = new Map<KernelId, KernelSlot>();

export function registerKernel(k: AgentKernel): void {
  _kernels.set(k.id, { kernel: k });
}

export function unregisterKernel(id: KernelId): boolean {
  return _kernels.delete(id);
}

export function getKernel(id: KernelId): AgentKernel | null {
  return _kernels.get(id)?.kernel ?? null;
}

export function listKernels(): AgentKernel[] {
  return Array.from(_kernels.values()).map((s) => s.kernel);
}

/** Boot a kernel: run `init()` if present, mark broken on failure. Returns
 *  the broken reason on failure, null on success. Always registers first so
 *  the SettingsPanel can render the row even when init fails. */
export async function bootKernel(k: AgentKernel): Promise<string | null> {
  registerKernel(k);
  if (!k.init) return null;
  try {
    await k.init();
    return null;
  } catch (e) {
    const reason = (e as Error).message ?? String(e);
    const slot = _kernels.get(k.id);
    if (slot) slot.brokenReason = reason;
    return reason;
  }
}

/** Call shutdown() if present, swallow errors, drop the slot. */
export async function shutdownKernel(id: KernelId): Promise<void> {
  const slot = _kernels.get(id);
  if (!slot) return;
  try {
    await slot.kernel.shutdown?.();
  } catch {
    // intentionally swallowed — registry must always release the slot
  }
  _kernels.delete(id);
}

export function isKernelBroken(id: KernelId): boolean {
  return Boolean(_kernels.get(id)?.brokenReason);
}

export function getKernelBrokenReason(id: KernelId): string | null {
  return _kernels.get(id)?.brokenReason ?? null;
}

/** Test helper — reset the kernel registry between cases. Best-effort
 *  shutdown on each slot. */
export function _resetKernelRegistryForTests(): void {
  for (const slot of _kernels.values()) {
    try {
      void slot.kernel.shutdown?.();
    } catch {
      // swallow
    }
  }
  _kernels.clear();
}
