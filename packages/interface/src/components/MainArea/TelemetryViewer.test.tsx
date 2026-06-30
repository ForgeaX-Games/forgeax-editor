/**
 * TelemetryViewer 单测(Track UI):纯逻辑 buildTraces / fmtDur / filterAndSortLogs 全分支 +
 * 纯展示组件 TelemetryView 的 JSX 渲染冒烟(prop 驱动,经 renderToStaticMarkup,稳定无 DOM)。
 */
import '../../lib/telemetry-test-prelude'; // 必须先于 store(经 TelemetryViewer)import:阻止 daemon-WS 自动连接
import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  buildTraces,
  fmtDur,
  filterAndSortLogs,
  TelemetryView,
  TelemetryViewer,
} from './TelemetryViewer';
import type { TelemetrySpan, TelemetryLog, TelemetryRecord } from '../../store';

const sp = (o: Partial<TelemetrySpan> & { spanId: string }): TelemetrySpan => ({
  kind: 'span', traceId: 't1', name: o.spanId, startTs: 0, ...o,
});
const lg = (o: Partial<TelemetryLog> & { ts: number; level: TelemetryLog['level'] }): TelemetryLog => ({
  kind: 'log', msg: 'm', ...o,
});

describe('buildTraces', () => {
  it('empty input → []', () => {
    expect(buildTraces([])).toEqual([]);
  });

  it('groups by traceId, nests by parentSpanId, DFS depth, unknown-parent as root', () => {
    const trees = buildTraces([
      sp({ spanId: 'root', startTs: 0, endTs: 10 }),
      sp({ spanId: 'child', parentSpanId: 'root', startTs: 1, endTs: 5 }),
      sp({ spanId: 'orphan', parentSpanId: 'ghost', startTs: 2, endTs: 3 }), // 未知 parent → root
      sp({ spanId: 'b', traceId: 't2', startTs: 100, endTs: 110 }),
    ]);
    expect(trees.length).toBe(2);
    const t1 = trees.find((t) => t.traceId === 't1')!;
    expect(t1.rows.map((r) => [r.span.spanId, r.depth])).toEqual([['root', 0], ['child', 1], ['orphan', 0]]);
    expect(trees[0].traceId).toBe('t2'); // 新 trace(startTs 100)在前
  });

  it('latest record per spanId wins (final overrides provisional)', () => {
    const trees = buildTraces([
      sp({ spanId: 's', startTs: 0, provisional: true }),
      sp({ spanId: 's', startTs: 0, endTs: 9 }),
    ]);
    expect(trees[0].rows.length).toBe(1);
    expect(trees[0].rows[0].span.endTs).toBe(9);
  });

  it('provisional (no endTs) extends trace window t1 to ~now', () => {
    const before = Date.now();
    const trees = buildTraces([sp({ spanId: 'x', startTs: 0 })]);
    expect(trees[0].t1).toBeGreaterThanOrEqual(before);
  });
});

describe('fmtDur', () => {
  it('formats sub-ms / ms / seconds', () => {
    expect(fmtDur(0.4)).toBe('<1ms');
    expect(fmtDur(250)).toBe('250ms');
    expect(fmtDur(1500)).toBe('1.50s');
  });
});

describe('filterAndSortLogs', () => {
  const logs = [lg({ ts: 1, level: 'info' }), lg({ ts: 3, level: 'error' }), lg({ ts: 2, level: 'info' })];
  it("'all' keeps everything, newest-first", () => {
    expect(filterAndSortLogs(logs, 'all').map((l) => l.ts)).toEqual([3, 2, 1]);
  });
  it('specific level filters then sorts', () => {
    expect(filterAndSortLogs(logs, 'info').map((l) => l.ts)).toEqual([2, 1]);
    expect(filterAndSortLogs(logs, 'error').map((l) => l.ts)).toEqual([3]);
  });
});

describe('TelemetryView render (prop-driven, SSR)', () => {
  it('renders empty state', () => {
    const html = renderToStaticMarkup(createElement(TelemetryView, { telemetry: [], onClear: () => {} }));
    expect(html).toContain('no spans yet');
    expect(html).toContain('no logs');
    expect(html).not.toContain('tv-clear'); // 无数据 → 无 clear 按钮
  });

  it('renders spans (normal/error/ongoing) + logs + clear button', () => {
    const telemetry: TelemetryRecord[] = [
      sp({ spanId: 'ok', startTs: 0, endTs: 10 }),
      sp({ spanId: 'err', startTs: 1, endTs: 5, status: { code: 'error' }, agentId: 'A' }),
      sp({ spanId: 'live', startTs: 2, provisional: true, sid: 'S' }),
      lg({ ts: 3, level: 'error', msg: 'boom', traceId: 't1abcdef1234' }),
      lg({ ts: 4, level: 'info', msg: 'hi' }),
    ];
    const html = renderToStaticMarkup(createElement(TelemetryView, { telemetry, onClear: () => {} }));
    expect(html).toContain('>ok<'); // span 名
    expect(html).toContain('tv-span-bar--error'); // error span 类
    expect(html).toContain('tv-span-bar--ongoing'); // provisional/ongoing 类
    expect(html).toContain('boom'); // log 行
    expect(html).toContain('tv-clear'); // 有数据 → clear 按钮
    expect(html).toContain('span / '); // 计数标题分支
    expect(html).toContain('t1abcdef'); // log 行的 traceId 短码分支
  });

  it('store-connected TelemetryViewer container renders (reads slice → delegates)', () => {
    const html = renderToStaticMarkup(createElement(TelemetryViewer));
    expect(html).toContain('tv-panel'); // 容器执行并渲染出 TelemetryView 外壳
  });
});
