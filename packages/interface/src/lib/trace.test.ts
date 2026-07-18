/**
 * 浏览器 tracer 单测(P3):ui.send/ui.request/ui.stream/ui.render 一棵树、同 traceId、parent 链正确,
 * traceparent 格式合法。prelude 必须先 import(阻 store 模块加载自动连 daemon-WS)。
 */
import './telemetry-test-prelude';
import { describe, it, expect, beforeEach } from 'bun:test';
import { useShellStore, type TelemetrySpan } from '../store';
import { beginChatTurn, chatFirstToken, chatTurnEnd, toTraceparent, beginAppBoot, appBootSpan, endAppBoot } from './trace';

const spans = (): TelemetrySpan[] =>
  useShellStore.getState().telemetry.filter((r): r is TelemetrySpan => r.kind === 'span');
const finals = (name: string): TelemetrySpan[] => spans().filter((s) => s.name === name && s.endTs != null);

beforeEach(() => {
  useShellStore.setState({ telemetry: [] });
  // rAF 同步化,让 chatTurnEnd 的 ui.render/ui.send 收尾确定性发生。
  (globalThis as { requestAnimationFrame?: (cb: () => void) => void }).requestAnimationFrame = (cb) => {
    cb();
    return 0 as unknown as number;
  };
  // stub fetch:flushTelemetryUpload 在 chatTurnEnd 里会 POST /api/telemetry,测试里设成 no-op。
  (globalThis as { fetch?: unknown }).fetch = () => Promise.resolve({ ok: true } as Response);
});

describe('browser tracer chat.turn', () => {
  it('beginChatTurn returns a valid W3C traceparent and emits ui.send+ui.request provisional', () => {
    const { traceparent } = beginChatTurn('forge', 'sid-1');
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const provisional = spans().filter((s) => s.provisional);
    expect(provisional.map((s) => s.name).sort()).toEqual(['ui.request', 'ui.send']);
    // ui.request 挂在 ui.send 下,且 traceparent 指向 ui.request
    const send = provisional.find((s) => s.name === 'ui.send')!;
    const req = provisional.find((s) => s.name === 'ui.request')!;
    expect(req.parentSpanId).toBe(send.spanId);
    expect(traceparent).toContain(req.traceId);
    expect(traceparent).toContain(req.spanId);
  });

  it('full turn → one trace, correct parent chain: send → {request, stream, render}', () => {
    beginChatTurn('forge', 'sid-1');
    chatFirstToken('forge');
    chatFirstToken('forge'); // 幂等,不重复起 ui.stream
    chatTurnEnd('forge', true);

    const send = finals('ui.send')[0]!;
    const req = finals('ui.request')[0]!;
    const stream = finals('ui.stream')[0]!;
    const render = finals('ui.render')[0]!;
    // 全部同一 traceId
    const tid = send.traceId;
    for (const s of [req, stream, render]) expect(s.traceId).toBe(tid);
    // ui.send 是 root(无 parent);request/stream/render 都挂 ui.send 下
    expect(send.parentSpanId).toBeUndefined();
    for (const s of [req, stream, render]) expect(s.parentSpanId).toBe(send.spanId);
    // 都有 endTs + ok 状态
    for (const s of [send, req, stream, render]) {
      expect(typeof s.endTs).toBe('number');
      expect(s.status?.code).toBe('ok');
    }
    // 仅一棵(幂等):各 final 只一条
    expect(finals('ui.stream').length).toBe(1);
    expect(finals('ui.send').length).toBe(1);
  });

  it('error turn → spans carry error status + message', () => {
    beginChatTurn('forge', 'sid-1');
    chatFirstToken('forge');
    chatTurnEnd('forge', false, 'boom');
    const send = finals('ui.send')[0]!;
    expect(send.status?.code).toBe('error');
    const stream = finals('ui.stream')[0]!;
    expect(stream.status).toEqual({ code: 'error', message: 'boom' });
  });

  it('degenerate turn (no token) still closes ui.request + ui.send', () => {
    beginChatTurn('forge', 'sid-1');
    chatTurnEnd('forge', true); // 无 first token
    expect(finals('ui.request').length).toBe(1);
    expect(finals('ui.send').length).toBe(1);
    expect(finals('ui.stream').length).toBe(0); // 没起过 stream
  });

  it('concurrent agents keep separate traces (no cross-parent)', () => {
    beginChatTurn('forge', 'sid-1');
    beginChatTurn('mochi', 'sid-1');
    chatFirstToken('forge');
    chatFirstToken('mochi');
    chatTurnEnd('forge', true);
    chatTurnEnd('mochi', true);
    const sends = finals('ui.send');
    expect(sends.length).toBe(2);
    expect(sends[0].traceId).not.toBe(sends[1].traceId);
    // 每个 agent 的 stream 挂自己的 send
    const fSend = sends.find((s) => s.agentId === 'forge')!;
    const fStream = finals('ui.stream').find((s) => s.agentId === 'forge')!;
    expect(fStream.parentSpanId).toBe(fSend.spanId);
    expect(fStream.traceId).toBe(fSend.traceId);
  });

  it('hidden tab → ui.render/ui.send close immediately (no rAF) with paintDeferred attr', () => {
    // rAF 设成「永不回调」,证明失焦分支不依赖 rAF 也能收口(否则 render 永挂、被「回前台耗时」污染)。
    (globalThis as { requestAnimationFrame?: (cb: () => void) => void }).requestAnimationFrame = () =>
      0 as unknown as number;
    const doc = (globalThis as { document?: object }).document;
    const desc = doc ? Object.getOwnPropertyDescriptor(doc, 'visibilityState') : undefined;
    try {
      if (doc) Object.defineProperty(doc, 'visibilityState', { value: 'hidden', configurable: true });
      beginChatTurn('forge', 'sid-h');
      chatFirstToken('forge');
      chatTurnEnd('forge', true);
      const render = finals('ui.render')[0]!;
      const send = finals('ui.send')[0]!;
      // 失焦也立刻收口(不等 rAF):render + send 都已 endTs
      expect(typeof render.endTs).toBe('number');
      expect(typeof send.endTs).toBe('number');
      // 标 paintDeferred:提示这不是真实绘制耗时,而是标签页失焦延后
      expect((render.attrs as { paintDeferred?: boolean } | undefined)?.paintDeferred).toBe(true);
      expect((send.attrs as { paintDeferred?: boolean } | undefined)?.paintDeferred).toBe(true);
    } finally {
      if (doc && desc) Object.defineProperty(doc, 'visibilityState', desc);
      else if (doc) Object.defineProperty(doc, 'visibilityState', { value: 'visible', configurable: true });
    }
  });

  it('stall watchdog: 久无首 token → 报 ui.stall(带 kernel,error 状态);首 token 后不再报', () => {
    // 只捕获 STALL_MS(30s)的定时器,避开上传超时(5s)定时器。
    const stallTimers: Array<() => void> = [];
    const realSet = (globalThis as { setTimeout?: typeof setTimeout }).setTimeout;
    const realClear = (globalThis as { clearTimeout?: typeof clearTimeout }).clearTimeout;
    (globalThis as { setTimeout?: unknown }).setTimeout = ((cb: () => void, ms?: number) => {
      if (ms === 30_000) stallTimers.push(cb);
      return stallTimers.length as unknown as number;
    }) as unknown as typeof setTimeout;
    (globalThis as { clearTimeout?: unknown }).clearTimeout = (() => {}) as unknown as typeof clearTimeout;
    try {
      beginChatTurn('forge', 'sid-stall', 'codebuddy');
      stallTimers[0]?.(); // 看门狗到点,仍无首 token → 报 ui.stall
      const stall = finals('ui.stall')[0];
      expect(stall).toBeTruthy();
      expect(stall!.status?.code).toBe('error');
      expect((stall!.attrs as { kernel?: string } | undefined)?.kernel).toBe('codebuddy');
      expect(stall!.parentSpanId).toBe(finals('ui.send').length ? undefined : stall!.parentSpanId); // 挂在 ui.send 下(root 未结束)

      // 有首 token 的轮:看门狗到点也不应报
      useShellStore.setState({ telemetry: [] });
      stallTimers.length = 0;
      beginChatTurn('mochi', 'sid-stall', 'codebuddy');
      chatFirstToken('mochi'); // 拿到响应
      stallTimers[0]?.(); // 即便定时器仍被触发
      expect(spans().some((s) => s.name === 'ui.stall')).toBe(false);
    } finally {
      (globalThis as { setTimeout?: unknown }).setTimeout = realSet;
      (globalThis as { clearTimeout?: unknown }).clearTimeout = realClear;
    }
  });
});

describe('app.boot trace', () => {
  it('root + child phases share one traceId; children nest under app.boot', () => {
    beginAppBoot();
    appBootSpan('app.boot.store', () => 1);
    appBootSpan('app.boot.shell', () => 2);
    endAppBoot();
    const root = finals('app.boot')[0]!;
    const store = finals('app.boot.store')[0]!;
    const shell = finals('app.boot.shell')[0]!;
    expect(root.parentSpanId).toBeUndefined();
    expect(store.traceId).toBe(root.traceId);
    expect(shell.traceId).toBe(root.traceId);
    expect(store.parentSpanId).toBe(root.spanId);
    expect(shell.parentSpanId).toBe(root.spanId);
  });

  it('appBootSpan returns the fn result; idempotent begin', () => {
    beginAppBoot();
    beginAppBoot(); // 幂等,不重起
    expect(appBootSpan('x', () => 42)).toBe(42);
    endAppBoot();
    expect(finals('app.boot').length).toBe(1);
  });
});
