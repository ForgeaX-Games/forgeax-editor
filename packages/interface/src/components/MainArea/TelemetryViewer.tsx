import { useMemo, useState } from 'react';
import { useShellStore, type TelemetryRecord, type TelemetrySpan, type TelemetryLog } from '../../store';
import './TelemetryViewer.css';

// TelemetryViewer — a dock panel for the observability (trace + log) feed.
//
// One store slice (`telemetry`) carries BOTH node-produced records (WS
// `{type:'telemetry'}`) and iframe-produced ones (postMessage
// `{type:'VAG_TELEMETRY'}`); see store.ts pushTelemetry. This viewer splits by
// `kind`:
//   - spans → a per-trace waterfall (nested by parentSpanId, bars positioned by
//     startTs and sized by duration; provisional spans render as「ongoing」).
//   - logs  → a newest-first stream with a level filter.
// 见 .claude/docs/架构设计/forgeax-os/可观测性-trace-log-v3-B档-并行执行计划-2026-06-24.md §C Track UI。

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

interface TraceTree {
  traceId: string;
  /** Earliest startTs / latest end across the trace (window for bar layout). */
  t0: number;
  t1: number;
  /** Spans flattened in render order (DFS by parent), with computed depth. */
  rows: Array<{ span: TelemetrySpan; depth: number }>;
}

/** Group spans by traceId and order each trace's spans into a depth-tagged DFS
 *  list (root spans first, children nested under their parentSpanId). Spans with
 *  an unknown / absent parent are treated as roots so nothing is dropped. */
export function buildTraces(spans: TelemetrySpan[]): TraceTree[] {
  // Latest record per spanId wins (onEnd `final` overrides the onStart
  // `provisional`, both share the same spanId).
  const bySpanId = new Map<string, TelemetrySpan>();
  for (const s of spans) bySpanId.set(s.spanId, s);
  const latest = [...bySpanId.values()];

  const byTrace = new Map<string, TelemetrySpan[]>();
  for (const s of latest) {
    const arr = byTrace.get(s.traceId) ?? [];
    arr.push(s);
    byTrace.set(s.traceId, arr);
  }

  const trees: TraceTree[] = [];
  for (const [traceId, list] of byTrace) {
    const ids = new Set(list.map((s) => s.spanId));
    const children = new Map<string, TelemetrySpan[]>();
    const roots: TelemetrySpan[] = [];
    for (const s of list) {
      if (s.parentSpanId && ids.has(s.parentSpanId)) {
        const arr = children.get(s.parentSpanId) ?? [];
        arr.push(s);
        children.set(s.parentSpanId, arr);
      } else {
        roots.push(s);
      }
    }
    const sortByStart = (a: TelemetrySpan, b: TelemetrySpan) => a.startTs - b.startTs;
    roots.sort(sortByStart);
    for (const arr of children.values()) arr.sort(sortByStart);

    const rows: TraceTree['rows'] = [];
    const walk = (s: TelemetrySpan, depth: number): void => {
      rows.push({ span: s, depth });
      for (const c of children.get(s.spanId) ?? []) walk(c, depth + 1);
    };
    for (const r of roots) walk(r, 0);

    let t0 = Infinity;
    let t1 = -Infinity;
    const now = Date.now();
    for (const s of list) {
      t0 = Math.min(t0, s.startTs);
      t1 = Math.max(t1, s.endTs ?? now); // provisional → extend to now
    }
    trees.push({ traceId, t0, t1, rows });
  }
  // Newest trace first (by its earliest span).
  trees.sort((a, b) => b.t0 - a.t0);
  return trees;
}

export function fmtDur(ms: number): string {
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function SpanBar({ span, depth, t0, t1 }: { span: TelemetrySpan; depth: number; t0: number; t1: number }) {
  const span0 = span.startTs;
  const span1 = span.endTs ?? Date.now();
  const total = Math.max(1, t1 - t0);
  const leftPct = ((span0 - t0) / total) * 100;
  const widthPct = Math.max(0.5, ((span1 - span0) / total) * 100);
  const dur = (span.endTs ?? span1) - span0;
  const isErr = span.status?.code === 'error';
  const cls = ['tv-span-bar', isErr ? 'tv-span-bar--error' : '', span.provisional || span.endTs == null ? 'tv-span-bar--ongoing' : '']
    .filter(Boolean)
    .join(' ');
  const who = span.agentId ? `${span.agentId}` : span.sid ?? '';
  return (
    <div className="tv-span-row">
      <div className="tv-span-label" style={{ paddingLeft: depth * 12 }} title={`${span.name} · ${span.spanId}`}>
        <span className="tv-span-name">{span.name}</span>
        <span className="tv-span-meta">
          {fmtDur(dur)}{span.endTs == null ? '…' : ''}{who ? ` · ${who}` : ''}
        </span>
      </div>
      <div className="tv-span-track">
        <div className={cls} style={{ left: `${leftPct}%`, width: `${widthPct}%` }} />
      </div>
    </div>
  );
}

/** 日志按 level 过滤(`'all'` = 不过滤)+ 按 ts 新→旧排序。纯函数,可独立单测。 */
export function filterAndSortLogs(logs: TelemetryLog[], level: LogLevel | 'all'): TelemetryLog[] {
  const filtered = level === 'all' ? logs : logs.filter((l) => l.level === level);
  return [...filtered].sort((a, b) => b.ts - a.ts);
}

/** store-connected 容器:读 telemetry slice + clear,委托给纯展示组件 {@link TelemetryView}。 */
export function TelemetryViewer() {
  const telemetry = useShellStore((s) => s.telemetry);
  const clearTelemetry = useShellStore((s) => s.clearTelemetry);
  return <TelemetryView telemetry={telemetry} onClear={clearTelemetry} />;
}

/** 纯展示组件(prop 驱动,不读 store)—— 便于 renderToStaticMarkup 注入 seeded 数据单测。 */
export function TelemetryView({ telemetry, onClear }: { telemetry: TelemetryRecord[]; onClear: () => void }) {
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all');

  const spans = useMemo(
    () => telemetry.filter((r: TelemetryRecord): r is TelemetrySpan => r.kind === 'span'),
    [telemetry],
  );
  const logs = useMemo(
    () => telemetry.filter((r: TelemetryRecord): r is TelemetryLog => r.kind === 'log'),
    [telemetry],
  );
  const traces = useMemo(() => buildTraces(spans), [spans]);
  const visibleLogs = useMemo(() => filterAndSortLogs(logs, levelFilter), [logs, levelFilter]);

  return (
    <div className="tv-panel">
      <div className="tv-bar">
        <span className="tv-title">
          Telemetry
          {telemetry.length ? ` · ${spans.length} span / ${logs.length} log` : ''}
        </span>
        {telemetry.length > 0 && (
          <button type="button" className="tv-clear" onClick={() => onClear()} title="clear telemetry">
            clear
          </button>
        )}
      </div>

      {/* ── Trace waterfall ───────────────────────────────────────────────── */}
      <div className="tv-section tv-traces thin-scrollbar">
        {traces.length === 0 && <div className="tv-empty">no spans yet</div>}
        {traces.map((tr) => (
          <div key={tr.traceId} className="tv-trace">
            <div className="tv-trace-head" title={tr.traceId}>
              <span className="tv-trace-id">{tr.traceId.slice(0, 12)}</span>
              <span className="tv-trace-dur">{fmtDur(tr.t1 - tr.t0)}</span>
              <span className="tv-trace-count">{tr.rows.length} spans</span>
            </div>
            {tr.rows.map(({ span, depth }) => (
              <SpanBar key={span.spanId} span={span} depth={depth} t0={tr.t0} t1={tr.t1} />
            ))}
          </div>
        ))}
      </div>

      {/* ── Log stream ────────────────────────────────────────────────────── */}
      <div className="tv-logbar">
        <span className="tv-logbar-title">Logs</span>
        <div className="tv-filters">
          <button
            type="button"
            className={`tv-filter ${levelFilter === 'all' ? 'tv-filter--on' : ''}`}
            onClick={() => setLevelFilter('all')}
          >
            all
          </button>
          {LOG_LEVELS.map((lv) => (
            <button
              key={lv}
              type="button"
              className={`tv-filter tv-filter--${lv} ${levelFilter === lv ? 'tv-filter--on' : ''}`}
              onClick={() => setLevelFilter(lv)}
            >
              {lv}
            </button>
          ))}
        </div>
      </div>
      <div className="tv-section tv-logs thin-scrollbar">
        {visibleLogs.length === 0 && <div className="tv-empty">no logs</div>}
        {visibleLogs.map((l, i) => {
          const d = new Date(l.ts);
          const stamp = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
          return (
            <div key={`${l.ts}-${i}`} className={`tv-log-row tv-log--${l.level}`}>
              <span className="tv-log-time">{stamp}</span>
              <span className={`tv-log-level tv-log-level--${l.level}`}>{l.level}</span>
              <span className="tv-log-msg">{l.msg}</span>
              {l.traceId && <span className="tv-log-trace" title={l.traceId}>{l.traceId.slice(0, 8)}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
