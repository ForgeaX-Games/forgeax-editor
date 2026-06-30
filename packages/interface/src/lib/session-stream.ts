/** SessionEvent → ChatMessage 桥（forgeax 原生 WS 实时流）
 *
 *  订阅 `lib/forgeax-bridge.onSessionEvent`，把 server 端 EventBus 派发的事件
 *  翻译成 store 里 ChatMessage 的 patch。复用现有的 ForgeCard 渲染（segments /
 *  toolCalls / thinking / providerId / errorMessage），跟 `store.sendMessage`
 *  里 cli-provider SSE 分支用同一套 reducer（appendChatSegment /
 *  upsertToolSegment）—— 两条路径渲染口径不分裂。
 *
 *  事件映射表（agenteam ref `hooks/types.ts` + forgeax `core/conscious-agent.ts`）：
 *
 *    server type             →  UI 动作
 *    ────────────────────────────────────────────────────────────────────────
 *    user_input              →  dedupe（sendMessage 已预 push user bubble；
 *                                以 clientMsgId 匹配；匹配上 skip）
 *    hook:turnStart          →  确保 active asst message 处于 streaming
 *    stream:llm  chunk.text       →  text segment append + m.text 累加
 *    stream:llm  chunk.thinking   →  thinking segment append + m.thinking 累加
 *    stream:llm  chunk.tool_call  →  tool segment upsert（status=running，args 流式）
 *    hook:toolCall           →  tool segment status=running，args 定稿
 *    hook:toolResult         →  对应 tool segment status=done/error + durationMs
 *    hook:assistantMessage   →  fall-through（stream 已累加，不重复）
 *    hook:turnEnd            →  status=done（aborted=true → truncated 标志）
 *    agent_crash             →  status=error, errorMessage
 *    hook:llmFallback/Retry  →  console.warn（暂不显示，等接入 inline warning）
 *    其它（hook:systemPrompt / hook:agentXxx / inbound_message）  →  silent
 *
 *  尚未实现的事件（等工具/subagent/todo_list 真接入再考虑）：
 *  - subagent_launched / sub-agent 流  → 落到 m.subAgents[emitterId]（待）
 *  - todo_write tool                   → groupTodoFlow 已存在，等 hook:toolCall
 *                                         能识别 name='todo_write' 后自然分组 */

import {
  useAppStore,
  appendChatSegment,
  upsertToolSegment,
  patchAgentMessages,
  readAgentMessages,
  type ChatMessage,
  type SystemDirection,
  type SystemLevel,
  type ToolCall,
} from '../store';
import { onSessionEvent, type SessionEvent } from './forgeax-bridge';
import { ratioFromUsage } from './event-engine/turn-accumulator';
import { chatFirstToken, chatTurnEnd } from './trace';
import { t } from '@/i18n';

// ─── server event payload shapes ─────────────────────────────────────────

interface StreamLlmPayload {
  chunk?: {
    type: 'text' | 'thinking' | 'tool_call' | 'tool_call_delta' | 'provider_sidecar' | 'usage';
    text?: string;
    id?: string;
    name?: string;
    arguments?: string;
    arguments_delta?: string;
  };
  turn?: number;
}

interface HookToolCallPayload {
  name?: string;
  args?: Record<string, unknown>;
  toolCall?: { id?: string; name?: string };
}

interface HookToolResultPayload {
  name?: string;
  durationMs?: number;
  error?: string;
  callId?: string;
}

interface HookTurnEndPayload {
  turn?: number;
  aborted?: boolean;
  error?: string;
}

interface UserInputPayload {
  content?: string;
  clientMsgId?: string;
}

// ─── file-touch extraction from tool calls ──────────────────────────────
const FILE_TOOL_PATH_KEY: Record<string, string> = {
  read_file: 'path',
  write_file: 'path',
  edit_file: 'file_path',
  apply_patch: 'path',
};

function extractFileTouch(
  sid: string,
  agentPath: string,
  callId: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
  ts: number,
): void {
  if (!args) return;
  const pathKey = FILE_TOOL_PATH_KEY[toolName];
  if (pathKey) {
    const filePath = args[pathKey];
    if (typeof filePath === 'string' && filePath) {
      const name = filePath.split('/').pop() ?? filePath;
      const op = toolName === 'read_file' ? 'read' : toolName === 'edit_file' ? 'edit' : toolName === 'apply_patch' ? 'patch' : 'write';
      useAppStore.getState().pushFileTouch(sid, agentPath, { callId, path: filePath, name, op, ts, status: 'running' });
    }
    return;
  }
  if (toolName === 'multi_edit') {
    const edits = args.edits;
    if (Array.isArray(edits)) {
      for (const e of edits as Array<{ file_path?: string }>) {
        if (typeof e.file_path === 'string' && e.file_path) {
          const name = e.file_path.split('/').pop() ?? e.file_path;
          useAppStore.getState().pushFileTouch(sid, agentPath, { callId, path: e.file_path, name, op: 'edit', ts, status: 'running' });
        }
      }
    }
  }
}

// ─── tool_call_delta throttle ────────────────────────────────────────────
// Batch rapid tool_call_delta events and flush once per animation frame to
// avoid overwhelming React renders (50+ setState per write_file).

interface PendingDelta {
  sid: string;
  agentId: string;
  msgId: string;
  callId: string;
  name: string;
  accumulated: string;
}

const pendingDeltas = new Map<string, PendingDelta>();
let deltaRafId: number | null = null;

function flushPendingDeltas(): void {
  deltaRafId = null;
  if (pendingDeltas.size === 0) return;
  const batch = [...pendingDeltas.values()];
  pendingDeltas.clear();

  for (const pd of batch) {
    patchMsg(pd.sid, pd.agentId, pd.msgId, (m) => {
      const existing = m.toolCalls.find((t) => t.callId === pd.callId);
      if (existing) {
        // args 已定稿为对象（hook:toolCall / 完整 tool_call chunk 已写入），或
        // 状态已终结 —— 这批 delta 是过期的流式尾巴，必须丢弃。覆写会把对象
        // args 打回字符串，AskUserCard 这类按对象 args 渲染的结构化卡片会永远
        // 停在「正在准备选项…」；强写 'running' 还会把已 done 的工具拉回转圈。
        if (typeof existing.args !== 'string' || existing.status !== 'running') return m;
        const updatedRaw = existing.args + pd.accumulated;
        const updatedTc: ToolCall = { ...existing, args: updatedRaw, status: 'running' };
        return {
          ...m,
          toolCalls: m.toolCalls.map((t) => (t.callId === pd.callId ? updatedTc : t)),
          segments: upsertToolSegment(m.segments ?? [], m.ts ?? Date.now(), updatedTc),
          status: 'streaming',
        };
      }
      const tc: ToolCall = { callId: pd.callId, name: pd.name, args: pd.accumulated, status: 'running' };
      return {
        ...m,
        toolCalls: [...m.toolCalls, { ...tc, at: m.text.length }],
        segments: upsertToolSegment(m.segments ?? [], m.ts ?? Date.now(), tc),
        status: 'streaming',
      };
    });
  }
}

function enqueueDelta(
  sid: string,
  agentId: string,
  msgId: string,
  callId: string,
  name: string,
  delta: string,
): void {
  const key = `${sid}:${callId}`;
  const existing = pendingDeltas.get(key);
  if (existing) {
    existing.accumulated += delta;
  } else {
    pendingDeltas.set(key, { sid, agentId, msgId, callId, name, accumulated: delta });
  }
  if (deltaRafId === null) {
    deltaRafId = requestAnimationFrame(flushPendingDeltas);
  }
}

/** args 定稿（hook:toolCall）时丢弃该 call 残留的未 flush delta —— 不丢的话
 *  下一帧 flush 会把定稿对象 args 覆写回字符串尾巴（flushPendingDeltas 里有
 *  同样的兜底 guard，这里提前丢避免无谓 patch）。 */
function dropPendingDelta(sid: string, callId: string): void {
  pendingDeltas.delete(`${sid}:${callId}`);
}

// ─── helpers ─────────────────────────────────────────────────────────────

/** 找 (sid, agentId) 这条独立 ledger 的 active streaming asst message。
 *  R3.5 (2026-05-23) — agentId 必传，每个 emitterId 都有自己的 streaming bubble。
 *  Forge 派活给 mochi 时两条 bubble 并存（在两个不同的 messagesByAgent 槽里），
 *  没有 agentId 这层多路复用 mochi 的 stream:llm chunks 会落到 Forge 那条 bubble。
 *  规则：在 messagesByAgent[agentId]（fallback tab.messages 当 agent 是 active 时）
 *  的末尾找 assistant + status='streaming'，找不到 → null。**不**主动 push 新
 *  bubble —— bubble 由 sendMessage 或 hook:turnStart auto-spawn 创建。 */
function findStreamingAsst(
  sid: string,
  agentId: string | null | undefined,
): { sid: string; agentId: string; msg: ChatMessage } | null {
  if (!agentId) return null;
  const state = useAppStore.getState();
  const msgs = readAgentMessages(state, sid, agentId);
  // Scan backward for the LAST assistant bubble still in 'streaming'. Previously
  // this only looked at the tail — but the message-queue feature can leave
  // queued user bubbles (status 'done') sitting *after* the in-flight assistant
  // bubble (interrupt/steer send pushes a user line while turn N is still
  // streaming). A strict tail check would then return null and the in-flight
  // bubble would never flip to 'done' on turnEnd. Sequential turns guarantee at
  // most one streaming assistant per slot, so "last streaming" is unambiguous.
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'assistant' && m.status === 'streaming') {
      return { sid, agentId, msg: m };
    }
  }
  return null;
}

/** Patch a specific agent slot's message by id —— routes through
 *  patchAgentMessages so the (sid, agentId) tuple gets the right slot. */
function patchMsg(
  sid: string,
  agentId: string,
  msgId: string,
  mut: (m: ChatMessage) => ChatMessage,
): void {
  useAppStore.setState((s) => patchAgentMessages(s, sid, agentId, (msgs) =>
    msgs.map((m) => (m.id === msgId ? mut(m) : m)),
  ));
}

/** Push a fresh assistant-streaming bubble to the (sid, agentId) slot —
 *  used by hook:turnStart when no UI-side sendMessage pre-pushed one (i.e.
 *  Forge invoked delegate_to_subagent → mochi receives user_input → mochi's
 *  turnStart fires without anyone having pushed a bubble for her). Without
 *  this auto-spawn the user would switch to mochi's tab and see only the
 *  user line, no streaming asst card. */
function spawnStreamingAsst(sid: string, agentId: string, ts: number): ChatMessage {
  const msg: ChatMessage = {
    id: `s-${ts}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'assistant',
    text: '',
    toolCalls: [],
    status: 'streaming',
    ts,
    providerId: 'forgeax',
  };
  useAppStore.setState((s) => patchAgentMessages(s, sid, agentId, (msgs) => [...msgs, msg]));
  return msg;
}

/** Append a system-role ChatMessage to the tab. Used for inter-agent traffic
 *  (来信 / 出信) and warning / error banners — anything that doesn't slot
 *  into the active assistant bubble.
 *
 *  Adjacent dedupe: identical text + level + direction collapses with the
 *  previous system msg (so a noisy retry burst doesn't fill the thread). */
function pushSystemMessage(
  sid: string,
  agentId: string | null,
  patch: {
    text: string;
    level?: SystemLevel;
    direction?: SystemDirection;
    source?: string;
    from?: string;
    to?: string;
    ts: number;
  },
): void {
  if (!patch.text) return;
  // System lines also need per-agent demux: a warning fired by Forge mid-
  // delegate (e.g. LLM retry) should land in Forge's slot, not pollute mochi's
  // thread when the user happens to be looking at mochi. Fall back to the
  // active agent when emitterId / event.to didn't yield one (rare — bus-level
  // events not tied to any agent).
  const targetAgent = agentId
    ?? useAppStore.getState().tabs.find((t) => t.sid === sid)?.agentId
    ?? null;
  if (!targetAgent) return;
  useAppStore.setState((s) => {
    const prev = readAgentMessages(s, sid, targetAgent);
    const last = prev[prev.length - 1];
    if (
      last &&
      last.role === 'system' &&
      last.text === patch.text &&
      last.level === patch.level &&
      last.direction === patch.direction
    ) {
      return {};
    }
    const sysMsg: ChatMessage = {
      id: `sys-${patch.ts}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'system',
      text: patch.text,
      toolCalls: [],
      status: 'done',
      ts: patch.ts,
      level: patch.level,
      direction: patch.direction,
      source: patch.source,
      from: patch.from,
      to: patch.to,
    };
    return patchAgentMessages(s, sid, targetAgent, (msgs) => [...msgs, sysMsg]);
  });
}

/** Resolve the currently-active agent for `sid` from the store. Used to
 *  classify event direction: an event whose `to === activeAgent` is incoming
 *  to the viewer; anything emitted by activeAgent with a `to` is outgoing. */
function getActiveAgentForSid(sid: string): string | null {
  const tab = useAppStore.getState().tabs.find((t) => t.sid === sid);
  return tab?.agentId ?? null;
}

/** Pull the most natural human-readable summary from an event payload —
 *  prefers `visual_display` (server-baked one-line) then falls back to
 *  common fields. Returns '' when nothing useful is present. */
function readableSummary(payload: Record<string, unknown>): string {
  const vis = payload.visual_display;
  if (typeof vis === 'string' && vis) return vis;
  const summary = payload.summary;
  if (typeof summary === 'string' && summary) return summary;
  const text = payload.text;
  if (typeof text === 'string' && text) return text;
  const message = payload.message;
  if (typeof message === 'string' && message) return message;
  const content = payload.content;
  if (typeof content === 'string' && content) return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content as Array<Record<string, unknown>>) {
      if (p && typeof p === 'object') {
        if (p.type === 'text' && typeof p.text === 'string') parts.push(p.text);
        else if (p.type === 'image_file' && typeof p.path === 'string') parts.push(t('sessionStream.imageRef', { path: p.path }));
        else if ((p.type === 'file' || p.type === 'text_file') && typeof p.path === 'string') parts.push(t('sessionStream.fileRef', { path: p.path }));
      }
    }
    if (parts.length) return parts.join(' ');
  }
  return '';
}

// ─── user_input dedupe ───────────────────────────────────────────────────

/** sendMessage 时调一次 markEmittedClientMsg(clientMsgId)，session-stream 在收到
 *  反射回来的 user_input 时检查 payload.clientMsgId —— 命中就 skip。
 *  小 LRU（保留最近 64 条 id），防止泄漏。 */
const _emittedClientMsgIds: string[] = [];
const _EMITTED_LRU_MAX = 64;
export function markEmittedClientMsg(clientMsgId: string): void {
  _emittedClientMsgIds.push(clientMsgId);
  if (_emittedClientMsgIds.length > _EMITTED_LRU_MAX) {
    _emittedClientMsgIds.shift();
  }
}
function isOwnUserInput(payload: UserInputPayload): boolean {
  if (!payload.clientMsgId) return false;
  return _emittedClientMsgIds.includes(payload.clientMsgId);
}

// ─── dispatch ─────────────────────────────────────────────────────────────

function dispatch(evt: SessionEvent): void {
  const { sid, emitterId, event } = evt;
  const type = event.type;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const ts = event.ts ?? Date.now();

  // R3.5 (2026-05-23) — per-agent message demux. Every event has an authoritative
  // owning agent:
  //   - emitterId = the agent that produced this event (LLM stream / hooks /
  //     tool calls / agent_crash). Goes to messagesByAgent[emitterId].
  //   - event.to = recipient for user_input / inter-agent inbound. user_input
  //     bubbles surface in the recipient's slot (Forge's delegate to mochi
  //     shows up as a user line on mochi's tab).
  // Without this multiplex, Forge + mochi running concurrently on the same
  // sid would collide on tab.messages' last streaming bubble.
  const emitter = emitterId || (typeof event.to === 'string' ? event.to : null);

  // ── 报错优先：任何 payload.error 非 toolResult 都升级成红色 system 行 ──
  // hook:toolResult 自己消化 error 到 toolCall.status，不重复渲染；其余事件
  // （breakpoint_continuation / agent_command 失败 / hook 内部异常等）都
  // 走这条统一渠道，跟 ink-renderer SystemLine level='error' 对齐。
  if (
    payload.error &&
    type !== 'hook:toolResult' &&
    type !== 'agent_crash' &&
    type !== 'hook:turnEnd'
  ) {
    const errText = String(payload.error);
    pushSystemMessage(sid, emitter, {
      text: errText,
      level: 'error',
      source: emitterId ? `${emitterId}(${type})` : type,
      from: emitterId,
      ts,
    });
    return;
  }

  // ── payload.warning：未挂到具体 hook 的兜底警告 ──
  // 跟 hook:llmFallback / hook:llmRetry 同色（黄），下面的专用 handler 在前先匹配。
  if (payload.warning && type !== 'hook:llmFallback' && type !== 'hook:llmRetry') {
    pushSystemMessage(sid, emitter, {
      text: String(payload.warning),
      level: 'warning',
      source: emitterId ? `${emitterId}(${type})` : type,
      from: emitterId,
      ts,
    });
    return;
  }

  // user_input 反射：sendMessage 已经预 push user bubble，匹配 clientMsgId
  // 就跳过；不匹配（curl / 外部触发 / 跨 agent delegate）则 push 一条 user bubble。
  // 路由到 event.to 这个 agent 的槽（mochi 收到 Forge 派的活 → 落到 mochi 的
  // messagesByAgent，用户切到 mochi 的 tab 才看得见）。没有 to 时 fallback 到
  // 当前 active agent。
  //
  // 跨 agent 派活（source='agent' + emitterId + to）特殊处理：在 emitter 槽推
  // 出信 (📤)、在 recipient 槽推来信 (📨) 的 SystemLine —— 用户在 forge tab 看到
  // 「我派给 mochi 的请求」要明显区别于「人类发给我的请求」，否则视觉上是同一个
  // user-bubble，跟自己的输入混淆。两条 ledger（forge / mochi）都会触发同一份
  // event，pushSystemMessage 的 adjacent dedupe 兜底重复。
  if (type === 'user_input' || event.source === 'user') {
    if (isOwnUserInput(payload as UserInputPayload)) return;
    const content = typeof payload.content === 'string' ? payload.content : '';
    if (!content) return;
    const state = useAppStore.getState();
    const tab = state.tabs.find((t) => t.sid === sid);
    if (!tab) return;
    const fromAgent = typeof emitterId === 'string' && emitterId.length > 0 ? emitterId : null;
    const toAgent = typeof event.to === 'string' && event.to.length > 0 ? event.to : null;
    const isInterAgent = event.source === 'agent' && fromAgent && toAgent;
    const evtTs = event.ts ?? Date.now();

    // 叙事工坊「完成即重唤醒」投给 Kotone 的系统提示（narrative-copilot.ts）：
    // 它不是人类用户打的字，渲染成「叙事工坊」来信的系统行，别伪装成 user 气泡。
    // 事件本身仍是 user_input → 正常触发 Kotone 的轮次（它随后产出完成总结）。
    if ((payload as { narrativeAutoNudge?: boolean }).narrativeAutoNudge) {
      const target = toAgent || tab.agentId;
      if (target) {
        pushSystemMessage(sid, target, {
          text: content,
          direction: 'incoming',
          source: t('sessionStream.narrativeWorkshop'),
          to: target,
          ts: evtTs,
        });
      }
      return;
    }

    if (isInterAgent) {
      pushSystemMessage(sid, fromAgent, {
        text: content,
        direction: 'outgoing',
        source: `${fromAgent}(user_input)`,
        from: fromAgent,
        to: toAgent,
        ts: evtTs,
      });
      pushSystemMessage(sid, toAgent, {
        text: content,
        direction: 'incoming',
        source: `${fromAgent}(user_input)`,
        from: fromAgent,
        to: toAgent,
        ts: evtTs,
      });
      return;
    }

    const targetAgent = toAgent || tab.agentId;
    if (!targetAgent) return;
    const userMsg: ChatMessage = {
      id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      text: content,
      toolCalls: [],
      status: 'done',
      ts: evtTs,
      ...(typeof payload.msgId === 'string' ? { msgId: payload.msgId } : {}),
    };
    useAppStore.setState((s) => patchAgentMessages(s, sid, targetAgent, (msgs) => [...msgs, userMsg]));
    return;
  }

  // ── checkpoint 回退点(rewind:*)──server CheckpointManager.notify 的瞬态
  // UI 通知(不落 WAL);持久真相在 ledger boundary 事件 + checkpoints.jsonl。
  // 状态落点统一走 store.applyRewindEvent。
  if (type.startsWith('rewind:')) {
    const kind = type.slice('rewind:'.length) as
      'done' | 'cancelled' | 'finalized' | 'overwrite' | 'overwrite-undone';
    if (kind === 'done' || kind === 'cancelled' || kind === 'finalized'
      || kind === 'overwrite' || kind === 'overwrite-undone') {
      useAppStore.getState().applyRewindEvent(sid, kind, payload);
    }
    return;
  }

  // hook:turnStart —— agent 开始 turn。
  //   1) 把现成 streaming bubble 的 m.ts 对齐到 event.ts（每个 event 都自带 ts，
  //      turnEnd 直接 ts - m.ts 算 durationMs，不需要单独的 startTs map）。
  //   2) **权威 isStreaming = true**（这条具体 agent 的 streamingByAgent 槽，
  //      不再是整个 tab 一份）：跨 agent 并发时 Forge 和 mochi 各自有 spinner
  //      状态，turnEnd 也按 emitterId 各自落。
  //   3) 没有现成 bubble（子 agent 被 delegate 触发 → 没人替它 sendMessage 预
  //      push）就 spawnStreamingAsst 起一条新的，让用户切过去能看到流。
  if (type === 'hook:turnStart') {
    if (!emitter) return;
    let ctx = findStreamingAsst(sid, emitter);
    if (!ctx) {
      const msg = spawnStreamingAsst(sid, emitter, ts);
      ctx = { sid, agentId: emitter, msg };
    } else {
      patchMsg(sid, emitter, ctx.msg.id, (m) => ({ ...m, ts }));
    }
    useAppStore.setState((s) => {
      const tabs = s.tabs.map((t) => {
        if (t.sid !== sid) return t;
        const streamingByAgent = { ...t.streamingByAgent, [emitter]: true };
        if (t.agentId === emitter) {
          return { ...t, streamingByAgent, isStreaming: true };
        }
        return { ...t, streamingByAgent };
      });
      const out: Partial<typeof s> = { tabs };
      if (s.activeSid === sid) {
        const active = tabs.find((t) => t.sid === sid);
        if (active && active.agentId === emitter) out.isStreaming = true;
      }
      return out;
    });
    return;
  }

  // stream:llm —— 高频 token / thinking / tool_call 流（payload.chunk = StreamEvent）
  if (type === 'stream:llm') {
    const p = payload as StreamLlmPayload;
    const chunk = p.chunk;
    if (!chunk) return;
    if (!emitter) return;
    let ctx = findStreamingAsst(sid, emitter);
    if (!ctx) {
      // Late-arriving chunks for an agent whose turnStart we missed (recovery
      // path / WS reconnect mid-turn). Spawn a bubble so the chunks have
      // somewhere to land — better than dropping silently.
      const msg = spawnStreamingAsst(sid, emitter, ts);
      ctx = { sid, agentId: emitter, msg };
    }

    if (chunk.type === 'text') {
      const t = chunk.text ?? '';
      if (!t) return;
      chatFirstToken(emitter); // 全链路 trace:首 token → 收 ui.request、起 ui.stream(幂等;thinking 站点亦调)
      patchMsg(sid, emitter, ctx.msg.id, (m) => ({
        ...m,
        text: m.text + t,
        segments: appendChatSegment(m.segments ?? [], { kind: 'text', ts, text: t }),
        status: 'streaming',
      }));
      return;
    }
    if (chunk.type === 'thinking') {
      const t = chunk.text ?? '';
      if (!t) return;
      chatFirstToken(emitter); // 全链路 trace:思考 token 也算首 token(真实 TTFT,幂等)
      patchMsg(sid, emitter, ctx.msg.id, (m) => ({
        ...m,
        thinking: (m.thinking ?? '') + t,
        segments: appendChatSegment(m.segments ?? [], { kind: 'thinking', ts, text: t }),
        status: 'streaming',
      }));
      return;
    }
    if (chunk.type === 'tool_call') {
      const callId = chunk.id ?? '';
      if (!callId) return;
      let parsedArgs: unknown = chunk.arguments ?? '';
      try { parsedArgs = JSON.parse(chunk.arguments ?? ''); } catch { /* partial */ }
      const tc: ToolCall = {
        callId,
        name: chunk.name ?? 'tool',
        args: parsedArgs,
        status: 'running',
      };
      patchMsg(sid, emitter, ctx.msg.id, (m) => ({
        ...m,
        toolCalls: m.toolCalls.some((t) => t.callId === callId)
          ? m.toolCalls.map((t) => (t.callId === callId ? { ...t, ...tc } : t))
          : [...m.toolCalls, { ...tc, at: m.text.length }],
        segments: upsertToolSegment(m.segments ?? [], ts, tc),
        status: 'streaming',
      }));
      return;
    }
    if (chunk.type === 'tool_call_delta') {
      const callId = chunk.id ?? '';
      if (!callId) return;
      const delta = chunk.arguments_delta ?? '';
      if (!delta) return;
      enqueueDelta(sid, emitter, ctx.msg.id, callId, chunk.name ?? 'tool', delta);
      return;
    }
    return;
  }

  // hook:toolCall —— tool 调用前，args 已定稿；upsert running。
  if (type === 'hook:toolCall') {
    const p = payload as HookToolCallPayload;
    const callId = p.toolCall?.id ?? '';
    if (!callId) return;
    if (!emitter) return;
    const ctx = findStreamingAsst(sid, emitter);
    if (!ctx) return;
    dropPendingDelta(sid, callId);
    const ts2 = event.ts ?? Date.now();
    const tc: ToolCall = {
      callId,
      name: p.name ?? p.toolCall?.name ?? 'tool',
      args: p.args ?? {},
      status: 'running',
    };
    patchMsg(sid, emitter, ctx.msg.id, (m) => ({
      ...m,
      toolCalls: m.toolCalls.some((t) => t.callId === callId)
        ? m.toolCalls.map((t) => (t.callId === callId ? { ...t, ...tc } : t))
        : [...m.toolCalls, { ...tc, at: m.text.length }],
      segments: upsertToolSegment(m.segments ?? [], ts2, tc),
    }));
    extractFileTouch(sid, emitter, callId, tc.name, p.args, ts2);
    return;
  }

  // hook:toolResult —— tool 执行完。
  if (type === 'hook:toolResult') {
    const p = payload as HookToolResultPayload;
    if (!emitter) return;
    const ctx = findStreamingAsst(sid, emitter);
    if (!ctx) return;
    const callId = p.callId;
    const apply = (tc: ToolCall): ToolCall => {
      const matched = callId ? tc.callId === callId : (tc.name === p.name && tc.status === 'running');
      if (!matched) return tc;
      return { ...tc, status: p.error ? 'error' : 'done', error: p.error };
    };
    patchMsg(sid, emitter, ctx.msg.id, (m) => ({
      ...m,
      toolCalls: m.toolCalls.map(apply),
      segments: (m.segments ?? []).map((s) =>
        s.kind === 'tool' ? { ...s, tool: apply(s.tool) } : s,
      ),
    }));
    if (callId) {
      useAppStore.getState().updateFileTouchStatus(sid, emitter, callId, p.error ? 'error' : 'done');
    }
    return;
  }

  // hook:turnEnd —— turn 结束。把 emitter 这个 agent 的 streaming msg 切到 done。
  if (type === 'hook:turnEnd') {
    const p = payload as HookTurnEndPayload;
    if (!emitter) return;
    const ctx = findStreamingAsst(sid, emitter);
    if (ctx) {
      const endTs = event.ts ?? Date.now();
      patchMsg(sid, emitter, ctx.msg.id, (m) => {
        const durationMs = endTs - m.ts;
        if (p.error) {
          return { ...m, status: 'error', errorMessage: p.error, durationMs };
        }
        return { ...m, status: 'done', durationMs };
      });
    }
    // 全链路 trace:收 ui.stream、起 ui.render,rAF 后(真实上屏帧)收 ui.render + ui.send root。
    chatTurnEnd(emitter, !p.error, p.error);
    useAppStore.setState((s) => {
      const tabs = s.tabs.map((t) => {
        if (t.sid !== sid) return t;
        const streamingByAgent = { ...t.streamingByAgent, [emitter]: false };
        if (t.agentId === emitter) {
          return { ...t, streamingByAgent, isStreaming: false };
        }
        return { ...t, streamingByAgent };
      });
      const out: Partial<typeof s> = { tabs };
      if (s.activeSid === sid) {
        const active = tabs.find((t) => t.sid === sid);
        if (active && active.agentId === emitter) out.isStreaming = false;
      }
      return out;
    });
    // Message-queue flush: a turn that ended *naturally* releases the next
    // client-side queued message (if any) as a fresh turn — this is what makes
    // queued messages process *sequentially* (one turn each) rather than being
    // coalesced into a single backend drain. We deliberately skip the flush on
    // abort (Stop) or error: pressing Stop must actually stop, not silently
    // kick off the queued backlog. The queued chips stay put so the user can
    // resume them manually. No-op when the queue is empty.
    if (!p.error && !p.aborted) {
      useAppStore.getState().flushQueuedForAgent(sid, emitter);
    }
    return;
  }

  // hook:assistantMessage —— LLM turn 完整 message snapshot。**不**碰 m.text /
  // segments —— stream:llm chunks 已经按 token 顺序累加好了（segments 数组保留了
  // text/thinking/tool 的真实交织顺序，ForgeCard 渲染时按 segment 顺序走 markdown
  // / Thought / tool block），重新覆盖会触发打字机动画再播一遍 + 丢掉中间异种
  // segment 的真实时序。
  // 真要 backfill 的是 model / usage（当前 ChatMessage 类型没字段，先 silent）。
  // 关键修复：保证 dispatch 只跑一次（按 key 注册 handler，HMR 重载覆盖旧的，
  // 见 subscribeSessionStream / forgeax-bridge.onSessionEvent）—— 这样
  // stream:llm 累加就是干净一份，根本不需要这里"final 校准"。
  if (type === 'hook:assistantMessage') {
    const usage = payload.usage as { inputTokens?: number; outputTokens?: number } | undefined;
    const model = payload.model as string | undefined;
    if (usage && model) {
      const pct = ratioFromUsage(usage, model);
      if (pct > 0) {
        useAppStore.setState((s) => {
          const tabs = s.tabs.map((t) => t.sid === sid ? { ...t, contextPct: pct } : t);
          return { tabs };
        });
      }
    }
    return;
  }

  // agent_crash —— emitter 那条 streaming msg 标 error + push system error 行。
  if (type === 'agent_crash') {
    const errMsg = typeof payload.error === 'string' ? payload.error
                : typeof payload.message === 'string' ? payload.message
                : 'agent crash';
    if (emitter) {
      const ctx = findStreamingAsst(sid, emitter);
      if (ctx) {
        patchMsg(sid, emitter, ctx.msg.id, (m) => ({ ...m, status: 'error', errorMessage: errMsg }));
      }
      // Crash flips the per-agent streaming flag too — without this the
      // spinner sticks until next turnStart.
      useAppStore.setState((s) => {
        const tabs = s.tabs.map((t) => {
          if (t.sid !== sid) return t;
          const streamingByAgent = { ...t.streamingByAgent, [emitter]: false };
          if (t.agentId === emitter) return { ...t, streamingByAgent, isStreaming: false };
          return { ...t, streamingByAgent };
        });
        const out: Partial<typeof s> = { tabs };
        if (s.activeSid === sid) {
          const active = tabs.find((t) => t.sid === sid);
          if (active && active.agentId === emitter) out.isStreaming = false;
        }
        return out;
      });
    }
    pushSystemMessage(sid, emitter, {
      text: errMsg,
      level: 'error',
      source: emitterId ? `${emitterId}(agent_crash)` : 'agent_crash',
      from: emitterId,
      ts,
    });
    return;
  }

  // hook:llmFallback / hook:llmRetry —— LLM 自适应警告，渲染成一条 ⚠ 行。
  if (type === 'hook:llmFallback' || type === 'hook:llmRetry') {
    const warning = typeof payload.warning === 'string' ? payload.warning : type;
    const label = type === 'hook:llmFallback' ? 'LLM fallback' : 'LLM retry';
    pushSystemMessage(sid, emitter, {
      text: warning,
      level: 'warning',
      source: emitterId ? `${emitterId}(${label})` : label,
      from: emitterId,
      ts,
    });
    return;
  }

  // inbound_message —— silent，对齐 ink-renderer event-formatter 的
  // `registerFormatter("inbound_message", () => null)`。理由：
  //   1. source='user' 的 inbound_message 是 user_input 的 LLM 镜像，user
  //      气泡已经显示过，再渲染一次是重复；
  //   2. source='agent:X' 的跨 agent inbound_message，承载的 LLMMessage 内容
  //      已经在 X 自己的 ledger（assistantMessage / tool_call）里渲染过了，
  //      接收方再镜像一次也是重复。
  // 真正的「来信/出信」由下面 fallback 分支按 event.to / emitterId vs viewer
  // 推断（处理那些非 hook、非 stream、非 inbound_message 的自定义业务事件）。

  // ── 兜底：未识别的非 hook:/_ 事件，按方向 + 文本翻成 system 行 ──
  // 这跟 ink-renderer event-formatter 末尾的 fallback path 同款：拿到任何带
  // visual_display / content / text 的事件，按 viewer 视角推断 direction，落到
  // ChatPanel system bubble。这样 admin / scheduler / cli-bus 等任何插件发的
  // 跨 agent 消息都能在聊天页面看见来去，而不必翻 ledger 文件。
  // 显式跳过：所有 hook:* / stream:* / 已被前面 case 消费的事件。
  if (type.startsWith('hook:') || type.startsWith('stream:') || type.startsWith('_')) {
    return;
  }
  // file-activity:* events are consumed by lib/file-activity-stream.ts —— it
  // has its own onSessionEvent handler. They have no chat representation and
  // would otherwise be rendered as system messages by the fallback below.
  if (type.startsWith('file-activity:')) return;
  // perception:* events are consumed by lib/perception-stream.ts (re-emitted to
  // the preview iframe). No chat representation — skip the fallback render.
  if (type.startsWith('perception:')) return;
  if (type === 'agent_added') {
    const p = payload as { path?: string; display?: string; parent?: string; depth?: number };
    if (p.path) {
      const s = useAppStore.getState();
      const prev = s.liveAgents[sid] ?? [];
      if (!prev.some((a) => a.path === p.path)) {
        s.setLiveAgents(sid, [...prev, {
          path: p.path,
          display: p.display ?? p.path,
          parent: p.parent ?? null,
          running: false,
          depth: p.depth ?? (p.parent ? 2 : 1),
        }]);
      }
    }
    return;
  }
  if (type === 'agent_removed') {
    const p = payload as { path?: string };
    if (p.path) {
      const s = useAppStore.getState();
      const prev = s.liveAgents[sid] ?? [];
      s.setLiveAgents(sid, prev.filter((a) => a.path !== p.path));
    }
    return;
  }
  if (
    type === 'media_attachment' ||
    type === 'agent_command' ||
    type === 'tick' ||
    type === 'breakpoint_continuation'
  ) {
    return;
  }
  const viewer = getActiveAgentForSid(sid);
  const text = readableSummary(payload);
  if (!text) return;
  const to = typeof event.to === 'string' ? event.to : undefined;
  let direction: SystemDirection | undefined;
  if (viewer && to && to === viewer) direction = 'incoming';
  else if (viewer && emitterId && emitterId === viewer && to) direction = 'outgoing';
  // Direction-aware routing: incoming → land in viewer (recipient) slot;
  // outgoing → land in emitterId (sender) slot. Generic broadcast → emitter
  // (or `to`) slot — pushSystemMessage falls back to viewer if neither.
  const targetSlot = direction === 'incoming'
    ? (to ?? viewer ?? null)
    : (emitterId ?? to ?? null);
  pushSystemMessage(sid, targetSlot, {
    text,
    direction,
    source: emitterId ? `${event.source ?? emitterId}(${type})` : `${event.source ?? type}`,
    from: emitterId,
    to,
    ts,
  });
}

// ─── public boot hook ─────────────────────────────────────────────────────

/** Boot 时调一次。重复调安全（按 key 注册，HMR 重载会覆盖旧 dispatch）。 */
export function subscribeSessionStream(): void {
  onSessionEvent('session-stream', dispatch);
}
