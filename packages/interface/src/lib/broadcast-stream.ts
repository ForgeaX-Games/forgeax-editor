// L1 公共广播 WS primitive —— 全页唯一一条 `/ws` 广播连接，按帧 `type` 分发。
//
// 设计意图（R5 store 收敛 · WS 归位）：
//  - 后端在 `/ws`（无 sid）上 broadcast 一批 app-agnostic 帧：`daemon-tick-*`（chat）、
//    `telemetry`（观测）、`workspace-changed`（全局壳 reload）。它们本是**同一条广播流**，
//    R4 期间被拆成了两条 raw socket（store.connectDaemonWs + chat/daemon-tick.ts）。
//  - 本 primitive 把它收敛回**一条**：全页单例、按 `msg.type` 字符串分发给订阅者。
//    它**不认识**任何帧的含义（daemon-tick 归 chat、telemetry 归观测、workspace-changed
//    归壳），只做传输 + 分发 —— 满足「L1 零 app 语义」。
//  - 「按 type 客户端分发」≠「后端多路复用」：后端本就 broadcast 全部帧，此处零后端改动。
//
// 关键纪律：**不在 module-load 自动连**（那是 R4 前 store 的反模式：import 即偷偷开 socket）。
// 由挂载方 boot 显式调 `connect()` 一次 —— studio 聚合壳 boot 一次；各独立 app boot 各一次。
// 全页因此只有一条广播 socket。
//
// HMR 安全：socket + 订阅表挂 globalThis；模块重求值时不重复建连、不丢订阅。

type Frame = { type?: string } & Record<string, unknown>;
type FrameHandler = (msg: Frame) => void;

interface StreamState {
  ws: WebSocket | null;
  /** 期望保持连接（connect 调用过、未 close）。reconnect 靠它判断要不要重连。 */
  desired: boolean;
  url: string;
  retryMs: number;
  retryTimer: number | null;
  /** type → handler 集合。type='*' 收全部帧（调试/透传用）。 */
  handlers: Map<string, Set<FrameHandler>>;
}

const _STREAM_FLAG = '__FORGEAX_BROADCAST_STREAM__';
type WithStream = { [_STREAM_FLAG]?: StreamState };
const _gt = globalThis as unknown as WithStream;
const _s: StreamState =
  _gt[_STREAM_FLAG] ??
  (_gt[_STREAM_FLAG] = {
    ws: null,
    desired: false,
    url: '',
    retryMs: 1000,
    retryTimer: null,
    handlers: new Map(),
  });

const RECONNECT_MAX_MS = 30_000;

function defaultUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

function dispatch(msg: Frame): void {
  const type = typeof msg.type === 'string' ? msg.type : '';
  const exact = type ? _s.handlers.get(type) : undefined;
  const wildcard = _s.handlers.get('*');
  if (exact) {
    for (const h of [...exact]) {
      try { h(msg); } catch (err) { console.warn(`[broadcast-stream] handler "${type}" threw`, err); }
    }
  }
  if (wildcard) {
    for (const h of [...wildcard]) {
      try { h(msg); } catch (err) { console.warn('[broadcast-stream] "*" handler threw', err); }
    }
  }
}

function open(): void {
  if (typeof window === 'undefined') return;
  if (_s.ws && _s.ws.readyState !== WebSocket.CLOSED) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(_s.url || defaultUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  _s.ws = ws;
  ws.onopen = () => {
    if (_s.ws !== ws) return;
    _s.retryMs = 1000;
  };
  ws.onmessage = (e) => {
    if (_s.ws !== ws) return;
    let obj: unknown;
    try { obj = JSON.parse(typeof e.data === 'string' ? e.data : ''); } catch { return; }
    if (obj && typeof obj === 'object') dispatch(obj as Frame);
  };
  ws.onclose = () => {
    if (_s.ws !== ws) return;
    _s.ws = null;
    if (_s.desired) scheduleReconnect();
  };
  ws.onerror = () => {
    try { ws.close(); } catch { /* ignore */ }
  };
}

function scheduleReconnect(): void {
  if (_s.retryTimer !== null) return;
  if (!_s.desired) return;
  _s.retryTimer = window.setTimeout(() => {
    _s.retryTimer = null;
    _s.retryMs = Math.min(_s.retryMs * 2, RECONNECT_MAX_MS);
    if (_s.desired) open();
  }, _s.retryMs);
}

/** boot 时调一次，拉起全页唯一的广播连接。幂等：已连则 no-op。
 *  @param url 可注入（默认 `${location.host}/ws`）——留一个注入点，方便未来 mock/回放。 */
export function connect(url?: string): void {
  if (typeof window === 'undefined') return;
  _s.desired = true;
  if (url) _s.url = url;
  if (_s.ws && _s.ws.readyState !== WebSocket.CLOSED) return;
  _s.retryMs = 1000;
  open();
}

/** 显式断开（一般不用；测试/卸载壳时可用）。 */
export function disconnect(): void {
  _s.desired = false;
  if (_s.retryTimer !== null) {
    window.clearTimeout(_s.retryTimer);
    _s.retryTimer = null;
  }
  if (_s.ws) {
    try { _s.ws.close(); } catch { /* ignore */ }
    _s.ws = null;
  }
}

/** 订阅某 `type` 的广播帧，返回 unsubscribe。`type='*'` 收全部帧。 */
export function subscribeBroadcast(type: string, handler: FrameHandler): () => void {
  let set = _s.handlers.get(type);
  if (!set) {
    set = new Set();
    _s.handlers.set(type, set);
  }
  set.add(handler);
  return () => {
    const cur = _s.handlers.get(type);
    if (cur) {
      cur.delete(handler);
      if (cur.size === 0) _s.handlers.delete(type);
    }
  };
}

/** 连接状态（调试/健康灯用）。 */
export function getBroadcastStatus(): { connected: boolean; url: string } {
  return { connected: _s.ws?.readyState === WebSocket.OPEN, url: _s.url || (typeof window !== 'undefined' ? defaultUrl() : '') };
}
