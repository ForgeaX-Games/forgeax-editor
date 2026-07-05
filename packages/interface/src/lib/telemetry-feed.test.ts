/**
 * Observability telemetry feed 单测(Track UI):store slice + 两条入信道
 * 汇入同一 500-cap slice。R5/P1 起，WS 侧 telemetry 帧改经 broadcast-stream →
 * bootBroadcast 的 subscribeBroadcast('telemetry') → pushTelemetry（薄接线，不在此测）；
 * 本文件测 store slice 语义 + postMessage(VAG_TELEMETRY) 入信道。
 */
import './telemetry-test-prelude'; // 历史前置(现为 no-op)：早期阻止 store module-load 自动连 WS
import { describe, it, expect, beforeEach } from 'bun:test';
import { useAppStore, type TelemetryRecord } from '../store';
import { ingestVagTelemetry } from '../components/StatusBar/healthBridge';

const span = (id: string): TelemetryRecord => ({ kind: 'span', traceId: 't', spanId: id, name: 'n', startTs: 1 });
const reset = () => useAppStore.setState({ telemetry: [] });

beforeEach(reset);

describe('telemetry store slice', () => {
  it('pushTelemetry appends; empty is a no-op', () => {
    useAppStore.getState().pushTelemetry([]);
    expect(useAppStore.getState().telemetry.length).toBe(0);
    useAppStore.getState().pushTelemetry([span('a'), span('b')]);
    expect(useAppStore.getState().telemetry.map((r) => (r as { spanId: string }).spanId)).toEqual(['a', 'b']);
  });

  it('caps at 500 and drops oldest', () => {
    const batch = Array.from({ length: 510 }, (_, i) => span(`s${i}`));
    useAppStore.getState().pushTelemetry(batch);
    const t = useAppStore.getState().telemetry;
    expect(t.length).toBe(500);
    expect((t[0] as { spanId: string }).spanId).toBe('s10'); // 最旧 10 条被丢
    expect((t[499] as { spanId: string }).spanId).toBe('s509');
  });

  it('clearTelemetry empties the slice', () => {
    useAppStore.getState().pushTelemetry([span('a')]);
    useAppStore.getState().clearTelemetry();
    expect(useAppStore.getState().telemetry.length).toBe(0);
  });
});

describe('postMessage ingest (VAG_TELEMETRY → ingestVagTelemetry)', () => {
  it('consumes VAG_TELEMETRY into the slice; ignores other types; empty = no-op', () => {
    expect(ingestVagTelemetry({ type: 'VAG_TELEMETRY', records: [span('p1')] })).toBe(true);
    expect(useAppStore.getState().telemetry.length).toBe(1);
    // 非 VAG_TELEMETRY(及 null)→ 不消费
    expect(ingestVagTelemetry({ type: 'VAG_CONSOLE', records: [span('x')] })).toBe(false);
    expect(ingestVagTelemetry(null)).toBe(false);
    expect(useAppStore.getState().telemetry.length).toBe(1);
    // VAG_TELEMETRY 但 records 空/非数组 → 消费(返 true)但不入 slice
    expect(ingestVagTelemetry({ type: 'VAG_TELEMETRY', records: [] })).toBe(true);
    expect(ingestVagTelemetry({ type: 'VAG_TELEMETRY', records: 'nope' })).toBe(true);
    expect(useAppStore.getState().telemetry.length).toBe(1);
  });
});
