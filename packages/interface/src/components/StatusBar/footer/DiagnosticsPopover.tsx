/**
 * DiagnosticsPopover — the right-side footer entry (demo `data-sb-pop="diag"`).
 * A status-bar chip that opens an upward card summarizing device / runtime /
 * project environment info. Same demo layout; data swapped to real sources:
 *
 *  - Device/memory/GPU: browser probes (navigator.platform / hardwareConcurrency;
 *    performance.memory JS heap for the meter; WebGPU adapter info for GPU).
 *  - Runtime: server RSS / uptime / WS from dashApi.health() (5s).
 *  - Project: engine / project / scene / assets from the editor-facts bus
 *    (useEditorFacts). The scene value has no public transport source and shows "—".
 *
 * Lives in interface, auto-registered by chrome-statusbar; sits far-right.
 */
import { useEffect, useState } from 'react';
import { Gauge, Circle } from 'lucide-react';
import { StripPopover } from '../StripPopover';
import { dashApi } from '../../../lib/dashboard-api';
import { useEditorFacts } from '../../../lib/editor-facts-bus';
import { useTranslation } from '../../../i18n';
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

function deviceLabel(unknownDevice: string, coreUnit: string): string {
  const nav = navigator as NavExt;
  const cores = nav.hardwareConcurrency;
  const plat = nav.platform || unknownDevice;
  return cores ? `${plat} · ${cores} ${coreUnit}` : plat;
}

function readHeap(): { usedMB: number; totalMB: number } | null {
  const m = (performance as Performance & { memory?: PerfMem }).memory;
  if (!m || !m.jsHeapSizeLimit) return null;
  return {
    usedMB: Math.round(m.usedJSHeapSize / 1048576),
    totalMB: Math.round(m.jsHeapSizeLimit / 1048576),
  };
}

async function probeGpu(unavailable: string): Promise<string> {
  try {
    const gpu = (navigator as NavExt).gpu;
    if (!gpu?.requestAdapter) return unavailable;
    const adapter = await gpu.requestAdapter();
    if (!adapter) return unavailable;
    const info =
      adapter.info ??
      (typeof adapter.requestAdapterInfo === 'function' ? await adapter.requestAdapterInfo() : undefined);
    if (!info) return 'WebGPU';
    const parts = [info.vendor, info.architecture].filter(
      (x): x is string => typeof x === 'string' && x.length > 0,
    );
    return parts.length ? parts.join(' · ') : 'WebGPU';
  } catch {
    return unavailable;
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
  const { t, i18n } = useTranslation();
  const [gpu, setGpu] = useState(() => t('statusBar.diagnostics.checking'));
  const [heap, setHeap] = useState<{ usedMB: number; totalMB: number } | null>(null);
  const [resState, setResState] = useState<ResState>('loading');
  const [res, setRes] = useState<RuntimeRes | null>(null);

  useEffect(() => {
    let cancelled = false;
    setGpu(t('statusBar.diagnostics.checking'));
    void probeGpu(t('statusBar.diagnostics.webgpuUnavailable')).then((g) => {
      if (!cancelled) setGpu(g);
    });
    return () => {
      cancelled = true;
    };
  }, [i18n.language, t]);

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
      label={t('statusBar.diagnostics.title')}
      tooltip={t('statusBar.diagnostics.tooltip')}
      title={
        <>
          <Gauge size={13} />
          {t('statusBar.diagnostics.title')}
        </>
      }
    >
      <div className="fx-pop-sec">
        <div className="fx-kv">
          <span>{t('statusBar.diagnostics.device')}</span>
          <b>{deviceLabel(t('statusBar.diagnostics.unknownDevice'), t('statusBar.diagnostics.cores'))}</b>
        </div>
        <div className="fx-meter">
          <div className="fx-meter-top">
            <span>{t('statusBar.diagnostics.memory')}</span>
            <b>{heap ? `${heap.usedMB} / ${heap.totalMB} MB` : t('statusBar.diagnostics.unavailable')}</b>
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
          <span>{t('statusBar.diagnostics.engine')}</span>
          <b className={facts ? 'ok' : undefined}>
            {facts ? <Circle size={12} /> : null}
            {facts?.engine ?? '—'}
          </b>
        </div>
      </div>
      <div className="fx-pop-div" />
      <div className="fx-pop-sec">
        <div className="fx-kv">
          <span>{t('statusBar.diagnostics.processMemory')}</span>
          <b>{resText((r) => `${r.rssMB} MB`)}</b>
        </div>
        <div className="fx-kv">
          <span>{t('statusBar.diagnostics.uptime')}</span>
          <b>{resText((r) => fmtUptime(r.uptime))}</b>
        </div>
        <div className="fx-kv">
          <span>{t('statusBar.diagnostics.wsConnections')}</span>
          <b>{resText((r) => String(r.ws))}</b>
        </div>
      </div>
      <div className="fx-pop-div" />
      <div className="fx-pop-sec">
        <div className="fx-kv">
          <span>{t('statusBar.diagnostics.project')}</span>
          <b>{facts?.project ?? '—'}</b>
        </div>
        <div className="fx-kv">
          <span>{t('statusBar.diagnostics.scene')}</span>
          <b>{facts?.scene ?? '—'}</b>
        </div>
        <div className="fx-kv">
          <span>{t('statusBar.diagnostics.assets')}</span>
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
