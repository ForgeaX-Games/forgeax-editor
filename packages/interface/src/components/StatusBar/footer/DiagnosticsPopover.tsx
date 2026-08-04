/**
 * DiagnosticsPopover — the right-side footer entry (demo `data-sb-pop="diag"`).
 * A status-bar chip that opens an upward card summarizing device / runtime /
 * project environment info. Same demo layout; data swapped to real sources:
 *
 *  - 设备/内存/GPU: browser probes (navigator.platform / hardwareConcurrency;
 *    performance.memory JS heap for the meter — the only live fractional memory
 *    the browser exposes; WebGPU adapter info for GPU).
 *  - 运行时: server RSS / uptime / WS from dashApi.health() (5s).
 *  - 项目: engine / project / scene / assets from the editor-facts bus
 *    (useEditorFacts). 场景物 has no public transport source → shows "—".
 *
 * Lives in interface, auto-registered by chrome-statusbar; sits far-right.
 */
import { useEffect, useState } from 'react';
import { Gauge, Circle } from 'lucide-react';
import { StripPopover } from '../StripPopover';
import { dashApi } from '../../../lib/dashboard-api';
import { useEditorFacts } from '../../../lib/editor-facts-bus';
import type { StatusItemContribution } from '../../../core/panels';
import './footer.css';

/** Compact uptime: "2h13m" / "13m" / "<1m". */
function fmtUptime(s: number): string {
  if (s < 60) return '<1m';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

interface NavExt extends Navigator {
  deviceMemory?: number;
  gpu?: { requestAdapter?: () => Promise<GpuAdapterLike | null> };
}
interface GpuAdapterLike {
  info?: Record<string, unknown>;
  requestAdapterInfo?: () => Promise<Record<string, unknown>>;
}
interface PerfMem {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

function deviceLabel(): string {
  const nav = navigator as NavExt;
  const cores = nav.hardwareConcurrency;
  const plat = nav.platform || '未知设备';
  return cores ? `${plat} · ${cores} 核` : plat;
}

function readHeap(): { usedMB: number; totalMB: number } | null {
  const m = (performance as Performance & { memory?: PerfMem }).memory;
  if (!m || !m.jsHeapSizeLimit) return null;
  return {
    usedMB: Math.round(m.usedJSHeapSize / 1048576),
    totalMB: Math.round(m.jsHeapSizeLimit / 1048576),
  };
}

async function probeGpu(): Promise<string> {
  try {
    const gpu = (navigator as NavExt).gpu;
    if (!gpu?.requestAdapter) return 'WebGPU 不可用';
    const adapter = await gpu.requestAdapter();
    if (!adapter) return 'WebGPU 不可用';
    const info =
      adapter.info ??
      (typeof adapter.requestAdapterInfo === 'function' ? await adapter.requestAdapterInfo() : undefined);
    if (!info) return 'WebGPU';
    const parts = [info.vendor, info.architecture].filter(
      (x): x is string => typeof x === 'string' && x.length > 0,
    );
    return parts.length ? parts.join(' · ') : 'WebGPU';
  } catch {
    return 'WebGPU 不可用';
  }
}

interface RuntimeRes {
  rssMB: number;
  uptime: number;
  ws: number;
}
type ResState = 'loading' | 'ok' | 'down';

export function DiagnosticsChip() {
  const facts = useEditorFacts();
  const [gpu, setGpu] = useState('检测中…');
  const [heap, setHeap] = useState<{ usedMB: number; totalMB: number } | null>(null);
  const [resState, setResState] = useState<ResState>('loading');
  const [res, setRes] = useState<RuntimeRes | null>(null);

  useEffect(() => {
    let cancelled = false;
    void probeGpu().then((g) => {
      if (!cancelled) setGpu(g);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      setHeap(readHeap());
      try {
        const h = await dashApi.health();
        if (cancelled) return;
        const rss = typeof h.mem?.rss === 'number' ? h.mem.rss : 0;
        setRes({ rssMB: Math.round(rss / 1048576), uptime: h.uptime ?? 0, ws: h.wsClients ?? 0 });
        setResState('ok');
      } catch {
        if (!cancelled) setResState('down');
      }
    };
    void tick();
    const timer = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const memPct = heap && heap.totalMB ? Math.round((heap.usedMB / heap.totalMB) * 100) : 0;
  const resText = (fmt: (r: RuntimeRes) => string): string =>
    resState === 'loading' ? '—' : resState === 'down' ? '!' : res ? fmt(res) : '—';

  return (
    <StripPopover
      icon="Gauge"
      label="诊断"
      tooltip="诊断 · 设备与运行时状态"
      title={
        <>
          <Gauge size={13} />
          诊断
        </>
      }
    >
      <div className="fx-pop-sec">
        <div className="fx-kv">
          <span>设备</span>
          <b>{deviceLabel()}</b>
        </div>
        <div className="fx-meter">
          <div className="fx-meter-top">
            <span>内存</span>
            <b>{heap ? `${heap.usedMB} / ${heap.totalMB} MB` : '不可用'}</b>
          </div>
          <div className="fx-meter-bar">
            <i style={{ width: `${memPct}%` }} />
          </div>
        </div>
        <div className="fx-kv">
          <span>GPU</span>
          <b>{gpu}</b>
        </div>
        <div className="fx-kv">
          <span>引擎</span>
          <b className={facts ? 'ok' : undefined}>
            {facts ? <Circle size={12} /> : null}
            {facts?.engine ?? '—'}
          </b>
        </div>
      </div>
      <div className="fx-pop-div" />
      <div className="fx-pop-sec">
        <div className="fx-kv">
          <span>进程内存</span>
          <b>{resText((r) => `${r.rssMB} MB`)}</b>
        </div>
        <div className="fx-kv">
          <span>运行时长</span>
          <b>{resText((r) => fmtUptime(r.uptime))}</b>
        </div>
        <div className="fx-kv">
          <span>WS 连接</span>
          <b>{resText((r) => String(r.ws))}</b>
        </div>
      </div>
      <div className="fx-pop-div" />
      <div className="fx-pop-sec">
        <div className="fx-kv">
          <span>项目</span>
          <b>{facts?.project ?? '—'}</b>
        </div>
        <div className="fx-kv">
          <span>当前场景</span>
          <b>{facts?.scene ?? '—'}</b>
        </div>
        <div className="fx-kv">
          <span>资产</span>
          <b>{facts ? facts.assets : '—'}</b>
        </div>
      </div>
    </StripPopover>
  );
}

// statusbar.center is the far-right group (flex-end); a LOWER priority than the
// health chip lands diagnostics as the RIGHTMOST chip.
export const diagnosticsStatusItem: StatusItemContribution = {
  kind: 'status-item',
  id: 'diagnostics',
  location: 'statusbar.center',
  priority: 5,
  item: { type: 'custom', render: () => <DiagnosticsChip /> },
};
