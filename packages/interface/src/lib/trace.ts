/**
 * 浏览器轻量 tracer —— 全链路 trace 的浏览器侧(P3)。
 *
 * 自建(不复用 Aegis:Aegis 是 Galileo 远端 RUM、traceId 对 app 不可读、无本地模式)。
 * 产 `TelemetrySpan`(形状镜像 store.ts / @forgeax/types),喂 `pushTelemetry` 进 TelemetryViewer;
 * 并(P4)经上传通道落 `<project>/.forgeax/sessions/<sid>/logs/`,和后端 span 同 traceId 拼一棵树。
 *
 * 链路:浏览器**起 root**(ui.send),把 ui.request 的 W3C traceparent 放进 POST payload 下行 →
 * 后端 host/kernel/agent/tool 全挂这棵 trace 下;回传的流事件(session-stream)按 agentId 找回本轮
 * 活动 trace,续建 ui.first-token/ui.stream/ui.turn-end/ui.render(rAF 取真实上屏帧)。
 * 浏览器自己是 root、自己持 traceId(按 agentId 索引活动 trace),**无需服务端 echo**。
 */
import { useAppStore, type TelemetrySpan, type TelemetryRecord } from '../store';

// ─── id + 序列化 ──────────────────────────────────────────────────────────
function randHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) c.getRandomValues(a);
  else for (let i = 0; i < bytes; i++) a[i] = Math.floor(Math.random() * 256);
  let s = '';
  for (const b of a) s += b.toString(16).padStart(2, '0');
  return s;
}
const newTraceId = (): string => randHex(16); // 32 hex
const newSpanId = (): string => randHex(8); //  16 hex

export interface SpanCtx {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTs: number;
  sid?: string;
  agentId?: string;
}

/** W3C traceparent(sampled flag 固定 01),供下行传播。 */
export function toTraceparent(ctx: SpanCtx): string {
  return `00-${ctx.traceId}-${ctx.spanId}-01`;
}

// ─── 出口:provisional(start)+ final(end)→ pushTelemetry(本地 viewer)+ 上传 buffer ──
// 浏览器 span 既进 TelemetryViewer(pushTelemetry,实时),又攒进 uploadBuf,turn 结束时
// 经 POST /api/telemetry 上传 → server 落项目本地 .forgeax/sessions/<sid>/logs/(与后端 span 同 trace)。
const uploadBuf: TelemetryRecord[] = [];

function emit(span: TelemetrySpan): void {
  try {
    useAppStore.getState().pushTelemetry([span]);
  } catch {
    /* 可观测性绝不拖垮 UI */
  }
  uploadBuf.push(span);
}

/** 把攒批的浏览器 span 上传到 server 落盘(best-effort,fire-and-forget,绝不拖垮 UI)。
 *  turn 结束(chatTurnEnd)+ app.boot 完成时调用。 */
export function flushTelemetryUpload(): void {
  if (uploadBuf.length === 0) return;
  const records = uploadBuf.splice(0);
  const f = (globalThis as { fetch?: typeof fetch }).fetch;
  if (!f) return;
  // 5s 超时:server 若被冻结/无响应(正是 hang 场景),上传不能无限挂起堆积 —— 否则浏览器侧
  //   也被拖累。超时即放弃这批(它们仍在内存 viewer 里,定位不丢)。
  const AC = (globalThis as { AbortController?: typeof AbortController }).AbortController;
  const ac = AC ? new AC() : undefined;
  const to = ac ? setTimeout(() => ac.abort(), 5000) : undefined;
  void f('/api/telemetry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ records }),
    ...(ac ? { signal: ac.signal } : {}),
  })
    .catch(() => {
      /* 上传失败不影响本地 viewer 已有的 span */
    })
    .finally(() => {
      if (to) clearTimeout(to);
    });
}

function startSpan(
  name: string,
  o: { traceId: string; parentSpanId?: string; sid?: string; agentId?: string; attrs?: Record<string, unknown> },
): SpanCtx {
  const ctx: SpanCtx = {
    traceId: o.traceId,
    spanId: newSpanId(),
    name,
    startTs: Date.now(),
    ...(o.parentSpanId ? { parentSpanId: o.parentSpanId } : {}),
    ...(o.sid ? { sid: o.sid } : {}),
    ...(o.agentId ? { agentId: o.agentId } : {}),
  };
  emit({ kind: 'span', ...ctx, provisional: true, ...(o.attrs ? { attrs: o.attrs } : {}) });
  return ctx;
}

function endSpan(
  ctx: SpanCtx,
  status?: { code: 'ok' | 'error'; message?: string },
  attrs?: Record<string, unknown>,
): void {
  emit({
    kind: 'span',
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    ...(ctx.parentSpanId ? { parentSpanId: ctx.parentSpanId } : {}),
    name: ctx.name,
    startTs: ctx.startTs,
    endTs: Date.now(),
    ...(ctx.sid ? { sid: ctx.sid } : {}),
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    ...(status ? { status } : {}),
    ...(attrs ? { attrs } : {}),
  });
}

// ─── chat.turn:每 agent 一棵活动 trace,按 agentId 索引 ──────────────────────
interface ActiveTurn {
  traceId: string;
  root: SpanCtx; // ui.send
  request?: SpanCtx; // ui.send → 首 token(真实 TTFT,thinking/text 皆算)
  stream?: SpanCtx; // 首 token → turn end(流式耗时)
  firstTokenSeen: boolean;
  ended: boolean;
  kernel?: string; // 本轮所选内核/provider(codebuddy / forgeax-core …),失速时标注便于定位
  stallTimer?: ReturnType<typeof setTimeout>; // 失速看门狗
  stalls: number; // 已报失速次数(每次 waitedMs 递增)
}
const active = new Map<string, ActiveTurn>();

// ─── 失速看门狗:浏览器是唯一「永不被冻」的目击者 ──────────────────────────────
// 后端若卡死/冻结(如 CLI 内核 job-control 冻结整个 server),进程内 trace/log 全失效;
// 浏览器侧在 STALL_MS 内拿不到首 token 就主动报 `ui.stall`(挂 ui.send 下,红点直观)+
// console.warn(devtools)——把「发送后卡死」从隐形变成有时间戳、带内核名的可见事件。
const STALL_MS = 30_000;

function clearStall(a: ActiveTurn): void {
  if (a.stallTimer) {
    const c = (globalThis as { clearTimeout?: typeof clearTimeout }).clearTimeout;
    c?.(a.stallTimer);
    a.stallTimer = undefined;
  }
}

function armStall(agentId: string): void {
  const setT = (globalThis as { setTimeout?: typeof setTimeout }).setTimeout;
  if (!setT) return;
  const a = active.get(agentId);
  if (!a) return;
  a.stallTimer = setT(() => {
    const cur = active.get(agentId);
    if (!cur || cur.firstTokenSeen || cur.ended) return; // 已有响应/已结束 → 不是失速
    cur.stalls += 1;
    const waitedMs = STALL_MS * cur.stalls;
    const kernel = cur.kernel ?? 'unknown';
    const secs = Math.round(waitedMs / 1000);
    // 作 ui.send 的子 span(viewer 里红点)+ 错误状态;即便 server 冻、上传失败,viewer 仍可见。
    const s = startSpan('ui.stall', {
      traceId: cur.traceId,
      parentSpanId: cur.root.spanId,
      agentId,
      sid: cur.root.sid,
      attrs: { waitedMs, kernel, reason: 'no-first-token' },
    });
    endSpan(s, { code: 'error', message: `no response after ${secs}s (kernel=${kernel})` }, { waitedMs, kernel });
    try {
      (globalThis as { console?: Console }).console?.warn(
        `[trace] ui.stall: 已等待 ${secs}s 仍无首 token,kernel=${kernel} sid=${cur.root.sid ?? '-'} —— 后端可能卡死/冻结`,
      );
    } catch {
      /* console 不可用不影响 */
    }
    flushTelemetryUpload();
    armStall(agentId); // 继续观察:再过 STALL_MS 仍无 → 升级再报(waitedMs 递增)
  }, STALL_MS);
}

/** 提交时调用:起 ui.send(root)+ ui.request,返回 ui.request 的 traceparent(放进 POST payload 下行)。
 *  kernel = 本轮所选内核/provider(失速时标注)。即刻早 flush + 起失速看门狗。 */
export function beginChatTurn(agentId: string, sid?: string, kernel?: string): { traceparent: string } {
  const traceId = newTraceId();
  // 同一 agentId 上一轮若从未收口(后端冻死 / WS 断 / turnEnd 丢失),其失速看门狗仍在续命;
  // 直接 active.set 覆盖会让旧 timer 失去引用却继续每 STALL_MS 触发(读到新条目重复报)。
  // 覆盖前先撤掉旧 timer —— active 因此被收敛到「distinct agentId 数」而非「turn 数」。
  const prev = active.get(agentId);
  if (prev) clearStall(prev);
  const root = startSpan('ui.send', { traceId, sid, agentId, ...(kernel ? { attrs: { kernel } } : {}) });
  const request = startSpan('ui.request', { traceId, parentSpanId: root.spanId, sid, agentId });
  active.set(agentId, { traceId, root, request, firstTokenSeen: false, ended: false, kernel, stalls: 0 });
  // 早 flush:provisional ui.send/ui.request 立即落盘(server 活着时)—— 即便随后卡死,
  //   trace 里也留有「起了但没结束」的可见痕迹(配合失速 span 一起定位)。
  flushTelemetryUpload();
  armStall(agentId); // 失速看门狗:STALL_MS 内无首 token → 报 ui.stall。
  return { traceparent: toTraceparent(request) };
}

/** 首个流式 token(thinking 或 text 皆算):结束 ui.request(=真实 TTFT,含思考前置耗时),
 *  起 ui.stream(=首 token→turnEnd 的流式耗时)。幂等(text/thinking 两处站点共用,先到先触发)。 */
export function chatFirstToken(agentId: string): void {
  const a = active.get(agentId);
  if (!a || a.firstTokenSeen) return;
  a.firstTokenSeen = true;
  clearStall(a); // 有响应了 → 撤销失速看门狗
  if (a.request) endSpan(a.request, { code: 'ok' });
  a.stream = startSpan('ui.stream', { traceId: a.traceId, parentSpanId: a.root.spanId, agentId, sid: a.root.sid });
}

/** turn 结束:收尾 ui.request/ui.stream,起 ui.render,rAF 后(真实上屏帧)结束 ui.render + ui.send root。 */
export function chatTurnEnd(agentId: string, ok: boolean, errMessage?: string): void {
  const a = active.get(agentId);
  if (!a || a.ended) return;
  a.ended = true;
  clearStall(a); // 轮结束 → 撤销失速看门狗
  const status: { code: 'ok' | 'error'; message?: string } = ok ? { code: 'ok' } : { code: 'error', ...(errMessage ? { message: errMessage } : {}) };
  if (a.request && !a.firstTokenSeen) endSpan(a.request, status); // 无 token 直接结束的退化轮
  if (a.stream) endSpan(a.stream, status);
  const render = startSpan('ui.render', { traceId: a.traceId, parentSpanId: a.root.spanId, agentId, sid: a.root.sid });
  const finish = (hidden: boolean): void => {
    // hidden=true:标签页失焦时浏览器会暂停 rAF → 不等真实绘制帧、立即收口并标 paintDeferred,
    //   否则 ui.render / ui.send 会被「标签页多久才回前台」污染成几十秒的假耗时(不是渲染慢)。
    const rootAttrs = { ...(a.kernel ? { kernel: a.kernel } : {}), ...(hidden ? { paintDeferred: true } : {}) };
    const renderAttrs = hidden ? { paintDeferred: true } : undefined;
    endSpan(render, status, renderAttrs); // 上屏完成(或失焦延后)
    endSpan(a.root, status, Object.keys(rootAttrs).length ? rootAttrs : undefined); // 整轮(ui.send)结束(保留 kernel)
    active.delete(agentId);
    flushTelemetryUpload(); // 本轮全部 span 上传 → 落项目 .forgeax
  };
  const doc = (globalThis as { document?: { visibilityState?: string } }).document;
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => void }).requestAnimationFrame;
  if (doc?.visibilityState === 'hidden' || !raf) finish(doc?.visibilityState === 'hidden');
  else raf(() => finish(false));
}

// ─── app.boot:应用初始化 trace(纯浏览器,无跨进程)──────────────────────────
let bootRoot: SpanCtx | null = null;

/** 应用启动:起 app.boot root(幂等)。 */
export function beginAppBoot(): void {
  if (bootRoot) return;
  bootRoot = startSpan('app.boot', { traceId: newTraceId(), agentId: 'shell' });
}

/** 在 app.boot 下包一个同步初始化阶段(如 store-wiring / shell-mount),自动起止 child span。 */
export function appBootSpan<T>(name: string, fn: () => T): T {
  if (!bootRoot) return fn();
  const s = startSpan(name, { traceId: bootRoot.traceId, parentSpanId: bootRoot.spanId, agentId: 'shell' });
  try {
    return fn();
  } finally {
    endSpan(s, { code: 'ok' });
  }
}

/** 启动完成:收 app.boot root 并上传(app.boot 无 sid → 落 .forgeax/sessions/browser/logs/)。 */
export function endAppBoot(): void {
  if (!bootRoot) return;
  endSpan(bootRoot, { code: 'ok' });
  bootRoot = null;
  flushTelemetryUpload();
}
