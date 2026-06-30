/**
 * useAgentAvatarState — 把 forgeax-bridge.onSessionEvent 流翻译成单个 agent
 * 当前应该播的 state 名字.
 *
 * 设计 (见 ADR-0019 §Decision §2-3):
 *   1. 每个 agentId 维护一个"活跃 universal event 集合".
 *   2. 收到上游 session-event → 归并到 universal event → 加入活跃集 + 起定时
 *      自动清理 (除非有显式的 end 事件配对, e.g. tool_use / tool_result).
 *   3. 渲染时从活跃集 → events 映射 → state 名 → priority 取最低数字者.
 *   4. 集合为空时回退 default.
 *
 * 关键边界:
 *   - hook 只读 emitterId; emitterId 形如 "forge/iori" → 取末段对比 agentId.
 *   - 多个组件 mount 同一 agent (e.g. ChatAgentCapsule + ForgeCard 同时显示 forge)
 *     → 模块级 store 单实例, 组件订阅. 不重复处理 event.
 *   - 仅当 rules 已加载才订阅 WS (避免最早的 turnStart 漏掉; 实际启动很快, 数十 ms).
 */
import { useEffect, useSyncExternalStore } from 'react';
import { onSessionEvent, type SessionEvent } from '../../lib/forgeax-bridge';
import type { AgentAvatarEvent, AgentAvatarRules } from './types';

// ─── module-level event store ────────────────────────────────────────────────

interface AgentBucket {
  /** 活跃中的 universal event → 触发时间戳 ms. 用 timestamp 配合 _setupDecay 做 GC. */
  active: Map<AgentAvatarEvent, number>;
  /** tool_active 是 paired event - 用 toolUseId 计数, 全部释放后才下线. */
  toolUseIds: Set<string>;
  /** one-shot 事件的定时器 id, 重复触发会先 clear 再起新计时. */
  timers: Map<AgentAvatarEvent, number>;
}

const _buckets = new Map<string, AgentBucket>();
const _listeners = new Map<string, Set<() => void>>();

function _ensureBucket(agentId: string): AgentBucket {
  let b = _buckets.get(agentId);
  if (!b) {
    b = { active: new Map(), toolUseIds: new Set(), timers: new Map() };
    _buckets.set(agentId, b);
  }
  return b;
}

function _notify(agentId: string): void {
  const subs = _listeners.get(agentId);
  if (!subs) return;
  for (const l of subs) {
    try {
      l();
    } catch (err) {
      console.warn('[avatar-state] listener threw', err);
    }
  }
}

function _activate(agentId: string, ev: AgentAvatarEvent, decayMs: number | null): void {
  const b = _ensureBucket(agentId);
  b.active.set(ev, Date.now());
  const prevTimer = b.timers.get(ev);
  if (prevTimer !== undefined) {
    window.clearTimeout(prevTimer);
    b.timers.delete(ev);
  }
  if (decayMs !== null) {
    const id = window.setTimeout(() => {
      const bb = _buckets.get(agentId);
      if (!bb) return;
      bb.active.delete(ev);
      bb.timers.delete(ev);
      _notify(agentId);
    }, decayMs);
    b.timers.set(ev, id);
  }
  _notify(agentId);
}

function _deactivate(agentId: string, ev: AgentAvatarEvent): void {
  const b = _buckets.get(agentId);
  if (!b) return;
  b.active.delete(ev);
  const t = b.timers.get(ev);
  if (t !== undefined) {
    window.clearTimeout(t);
    b.timers.delete(ev);
  }
  _notify(agentId);
}

function _resetAgent(agentId: string): void {
  const b = _buckets.get(agentId);
  if (!b) return;
  for (const t of b.timers.values()) window.clearTimeout(t);
  b.active.clear();
  b.toolUseIds.clear();
  b.timers.clear();
  _notify(agentId);
}

// ─── universal event mapping ─────────────────────────────────────────────────

// stream:llm 文本/思考流逝度: 上一个 chunk 后多少 ms 内还算"活跃".
const SPEAKING_DECAY_MS = 800;
const REASONING_DECAY_MS = 1200;
// one-shot 信号 (run_start / run_end / error / production / metabolism / media):
// 进入后保持的时间, 之后自动落到下一个优先级.
const ONESHOT_DECAY_MS = 1500;
// run_end 是"刻意短暂"显示 (回到 期待 的过渡), 800ms 即可.
const RUN_END_DECAY_MS = 800;
const ERROR_DECAY_MS = 5000;

/** WS dispatcher key. 首次任意组件 mount 时注册, 之后常驻 (HMR 重载用同 key 覆盖). */
const WS_KEY = 'agent-avatar-state';
let _wsRegistered = false;

function _ensureWsRegistered(): void {
  if (_wsRegistered) return;
  _wsRegistered = true;
  onSessionEvent(WS_KEY, (msg: SessionEvent) => {
    const emitterId = msg.emitterId ?? msg.event.source.replace(/^agent:/, '');
    // emitterId 形如 "forge/iori"; 取末段做 agent key (跟 server 端 def.id 对齐).
    const agentTail = (emitterId.split('/').pop() ?? emitterId).trim();
    if (!agentTail) return;
    const ev = msg.event;
    const t = ev.type;

    // 标准事件 → universal event 归并表.
    //
    // ⚠️ 重要 (debug 留底): server 端 cli-event-bridge.ts 实际发的事件**没有**
    // AG-UI 协议里的 stream:llm — claude-code driver 用 token 事件累积 buffer,
    // 直到 flushAssistantText 才发一条 hook:assistantMessage. 也就是说:
    //   - 没有逐 token 的 speaking 信号
    //   - 只发 turnStart / turnEnd / agent_log(thinking|error) /
    //     stream:tool_use / stream:tool_result / hook:assistantMessage
    // 之前按 AG-UI spec 监听 stream:llm 永远收不到, 导致 kotone 这种 "纯写文字、
    // 不调工具" 的 agent 全程保持 default 状态.
    //
    // 修法: 把"turn 进行中"近似为 speaking_active 持续信号. tool/thinking 通过
    // priority 表自动覆盖 (认真 3 < 专注 5 < 开心 6), turnEnd 一并清掉.

    // ──── 控制类 ───────────────────────────────────────────────────
    if (t === 'hook:turnStart') {
      _resetAgent(agentTail);
      _activate(agentTail, 'run_start', ONESHOT_DECAY_MS);
      // 长驻型 speaking_active: 没有 token 级事件, 用 turn 包络近似. 30s 安全网
      // 避免 turnEnd 丢失时 agent 永远停在 speaking — 真正的下线靠下面 turnEnd.
      _activate(agentTail, 'speaking_active', 30_000);
      return;
    }
    if (t === 'hook:turnEnd') {
      // 不直接 reset (会瞬时跳到 default); 改为短暂打上 run_end 标志, 自然 decay
      // 再回 default. 保留 error_signal (难过) 不被冲掉 - error_signal 自己 5s decay.
      const b = _ensureBucket(agentTail);
      // 显式关掉所有持续型(speaking/reasoning/tool_active), 留 one-shot 信号自然衰减.
      _deactivate(agentTail, 'speaking_active');
      _deactivate(agentTail, 'reasoning_active');
      b.toolUseIds.clear();
      _deactivate(agentTail, 'tool_active');
      _activate(agentTail, 'run_end', RUN_END_DECAY_MS);
      return;
    }
    if (t === 'agent_crash') {
      _activate(agentTail, 'error_signal', ERROR_DECAY_MS);
      return;
    }

    // ──── 内容流 ───────────────────────────────────────────────────
    // hook:assistantMessage 在 flushAssistantText 时发 (turn 结束 / tool call 切换),
    // 用它续命 speaking_active. 间隙里靠 turnStart 的 30s 安全网.
    if (t === 'hook:assistantMessage') {
      const text = (ev.payload as { msg?: { content?: string } } | undefined)?.msg?.content;
      if (text && text.length > 0) {
        _activate(agentTail, 'speaking_active', SPEAKING_DECAY_MS * 4); // 3.2s ride-out
      }
      return;
    }
    if (t === 'agent_log') {
      const p = ev.payload as { level?: string; subtype?: string };
      if (p?.level === 'error') {
        _activate(agentTail, 'error_signal', ERROR_DECAY_MS);
        return;
      }
      if (p?.subtype === 'thinking') {
        _activate(agentTail, 'reasoning_active', REASONING_DECAY_MS);
        return;
      }
      return;
    }

    // ──── 工具配对 ─────────────────────────────────────────────────
    if (t === 'stream:tool_use') {
      const toolUseId = (ev.payload as { toolUseId?: string })?.toolUseId;
      const b = _ensureBucket(agentTail);
      if (toolUseId) b.toolUseIds.add(toolUseId);
      _activate(agentTail, 'tool_active', 30_000);
      return;
    }
    if (t === 'stream:tool_result') {
      const toolUseId = (ev.payload as { toolUseId?: string })?.toolUseId;
      const b = _buckets.get(agentTail);
      if (b && toolUseId) {
        b.toolUseIds.delete(toolUseId);
        if (b.toolUseIds.size === 0) _deactivate(agentTail, 'tool_active');
      }
      return;
    }

    // CUSTOM 信号 (sub_agent / production / metabolism / media) — P1 暂不接.
    // observatory event-adapter 派发它们时用的是同一 eventBus, 后续接入只需
    // 在这里加 case (见 ADR-0019 §Decision §6).
  });
}

// ─── selector: 当前状态 ──────────────────────────────────────────────────────

function _topState(rules: AgentAvatarRules, b: AgentBucket | undefined): string {
  if (!b || b.active.size === 0) {
    return rules.default;
  }
  let bestName: string | null = null;
  let bestPriority = Number.POSITIVE_INFINITY;
  for (const ev of b.active.keys()) {
    const stateName = rules.events[ev];
    if (!stateName) continue;
    if (!rules.states[stateName]) continue;
    const pr = rules.priority[stateName] ?? 999;
    if (pr < bestPriority) {
      bestPriority = pr;
      bestName = stateName;
    }
  }
  return bestName ?? rules.default;
}

export function useAgentAvatarState(
  agentId: string | null | undefined,
  rules: AgentAvatarRules | null,
): string | null {
  // 订阅 WS 一次 (常驻); 即使 rules 暂时还没 ready, 也开始 buffer 事件, 不丢首批.
  useEffect(() => {
    _ensureWsRegistered();
  }, []);

  // useSyncExternalStore: 模块级 store → 多组件共享同一份事件流, 不会重复处理.
  const subscribe = (cb: () => void) => {
    if (!agentId) return () => {};
    let subs = _listeners.get(agentId);
    if (!subs) {
      subs = new Set();
      _listeners.set(agentId, subs);
    }
    subs.add(cb);
    return () => {
      subs!.delete(cb);
      if (subs!.size === 0) _listeners.delete(agentId);
    };
  };
  const getSnapshot = () => {
    if (!agentId) return '__null__';
    const tail = agentId.split('/').pop() ?? agentId;
    const b = _buckets.get(tail);
    if (!rules) return '__null__';
    return _topState(rules, b);
  };

  const stateName = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return stateName === '__null__' ? null : stateName;
}
