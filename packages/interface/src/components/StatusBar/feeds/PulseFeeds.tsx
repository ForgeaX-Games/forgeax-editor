/**
 * Bus-kind pulse chips — originally rendered in PreviewMode's pt-right
 * toolbar (P3.98 / P4.6 / P4.7 / P4.23-25). 2026-05-17 moved to the global
 * status bar so the same live BUS / MB / PROV / SKILL / TOOL / AGENT
 * indicators appear in one fixed location regardless of mode.
 *
 * Each `*Feed` polls its source (same cadence as the old impl), then renders
 * a `<StatusChip>` and pushes it onto the registry through `useStatusBarItem`.
 * The visual primitive is shared so the strip reads as a coherent unit; only
 * the `tone` color changes between kinds (the established kind palette:
 * lime/teal/amber/gold/orange/violet).
 */

import { useEffect, useRef, useState } from 'react';
import { Brain, Cpu, Sparkles, Wrench, Bot, Radio } from 'lucide-react';
import { useAppStore } from '../../../store';
import { listBusPlugins } from '../../../lib/bus-api';
import { dashApi } from '../../../lib/dashboard-api';
import { useStatusBarItem } from '../store';
import { StatusChip, type ChipState } from '../StatusChip';

export function PulseFeeds() {
  return (
    <>
      <BusPulseFeed />
      <ModelBindingPulseFeed />
      <ProvidersPulseFeed />
      <SkillPulseFeed />
      <ToolPulseFeed />
      <AgentPulseFeed />
    </>
  );
}

// ─── BUS · ringSize pulse ────────────────────────────────────────────────

function BusPulseFeed() {
  const [ringSize, setRingSize] = useState<number | null>(null);
  const [state, setState] = useState<ChipState>('loading');
  const [flashKey, setFlashKey] = useState(0);
  const [lastDelta, setLastDelta] = useState<number>(0);
  const prevRingRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const h = await dashApi.health();
        if (cancelled) return;
        const rs = h.bus?.ringSize;
        if (typeof rs !== 'number') { setState('down'); return; }
        const prev = prevRingRef.current;
        prevRingRef.current = rs;
        setRingSize(rs);
        setState('ok');
        if (prev != null && rs > prev) {
          setLastDelta(rs - prev);
          setFlashKey((k) => k + 1);
        }
      } catch { if (!cancelled) setState('down'); }
    };
    void poll();
    const t = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const value = state === 'loading' ? '—' : state === 'down' ? '!' : (ringSize ?? 0).toLocaleString();
  const title =
    state === 'loading' ? 'bus pulse · 等待首次 /api/health …' :
    state === 'down' ? 'bus pulse · health 拉不到（server down？）' :
    `bus pulse · ring=${ringSize} · 最近 Δ=${lastDelta} · 每 2s 拉一次`;

  useStatusBarItem({
    id: 'bus.pulse',
    slot: 'right',
    priority: 100,
    node: (
      <StatusChip
        tone="lime"
        state={state}
        icon={Radio}
        label="BUS"
        value={value}
        title={title}
        flashKey={flashKey}
      />
    ),
  });
  return null;
}

// ─── MB · model-binding kind count ────────────────────────────────────────

function ModelBindingPulseFeed() {
  const setMode = useAppStore((s) => s.setMode);
  const openSettings = useAppStore((s) => s.openSettings);
  const setPendingBusKindFilter = useAppStore((s) => s.setPendingBusKindFilter);
  const [state, setState] = useState<ChipState>('loading');
  const [count, setCount] = useState<number>(0);
  const [ids, setIds] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await listBusPlugins('model-binding');
        if (cancelled) return;
        setState(r.count > 0 ? 'ok' : 'empty');
        setCount(r.count);
        setIds(r.items.map((p) => p.id));
      } catch { if (!cancelled) setState('down'); }
    };
    void tick();
    const id = setInterval(tick, 12000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const value = state === 'loading' ? '—' : state === 'down' ? '!' : count.toString();
  const title =
    state === 'ok' || state === 'empty'
      ? count > 0
        ? `Model bindings · ${count} on bus · 单击下钻 Bus admin →\n` + ids.map((id) => `· ${id}`).join('\n')
        : `Model bindings · 0 plugins · 单击进入 Bus admin`
      : state === 'down' ? 'Model bindings · Bus 列表暂不可读' : 'Model bindings · loading…';

  useStatusBarItem({
    id: 'bus.mb',
    slot: 'right',
    priority: 90,
    node: (
      <StatusChip
        tone="teal"
        state={state}
        icon={Brain}
        label="MB"
        value={value}
        title={title}
        onClick={() => { openSettings('plugins'); setPendingBusKindFilter('model-binding'); }}
      />
    ),
  });
  return null;
}

// ─── PROV · cli-providers health ──────────────────────────────────────────

type ProvHealthState =
  | { kind: 'loading' }
  | { kind: 'down' }
  | { kind: 'ok'; ok: number; total: number; rows: Array<{ id: string; ok: boolean; detail?: string }> };

function ProvidersPulseFeed() {
  const setMode = useAppStore((s) => s.setMode);
  const openSettings = useAppStore((s) => s.openSettings);
  const setPendingBusKindFilter = useAppStore((s) => s.setPendingBusKindFilter);
  const [state, setState] = useState<ProvHealthState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await dashApi.providers();
        if (cancelled) return;
        const rows = r.providers.map((p) => ({ id: p.id, ok: !!p.health?.ok, detail: p.health?.detail }));
        const ok = rows.filter((p) => p.ok).length;
        setState({ kind: 'ok', ok, total: rows.length, rows });
      } catch { if (!cancelled) setState({ kind: 'down' }); }
    };
    void tick();
    const id = setInterval(tick, 10000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const chipState: ChipState =
    state.kind === 'ok'
      ? state.ok === state.total ? 'ok' : state.ok === 0 ? 'down' : 'warn'
      : state.kind === 'down' ? 'down' : 'loading';
  const value =
    state.kind === 'ok' ? `${state.ok}/${state.total}` :
    state.kind === 'down' ? '!' : '—';
  const title =
    state.kind === 'ok'
      ? `CLI Providers — ${state.ok}/${state.total} ok · 单击下钻 Bus admin →\n` +
        state.rows.map((p) => `${p.ok ? '✓' : '✗'} ${p.id}${p.detail ? ` — ${p.detail}` : ''}`).join('\n')
      : state.kind === 'down' ? 'CLI Providers — endpoint unreachable' : 'CLI Providers — loading…';

  useStatusBarItem({
    id: 'bus.prov',
    slot: 'right',
    priority: 85,
    node: (
      <StatusChip
        tone="amber"
        state={chipState}
        icon={Cpu}
        label="PROV"
        value={value}
        title={title}
        onClick={() => { openSettings('plugins'); setPendingBusKindFilter('cli-provider'); }}
      />
    ),
  });
  return null;
}

// ─── SKILL ────────────────────────────────────────────────────────────────

function SkillPulseFeed() {
  const setMode = useAppStore((s) => s.setMode);
  const openSettings = useAppStore((s) => s.openSettings);
  const setPendingBusKindFilter = useAppStore((s) => s.setPendingBusKindFilter);
  const [state, setState] = useState<ChipState>('loading');
  const [count, setCount] = useState<number>(0);
  const [ids, setIds] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await listBusPlugins('skill');
        if (cancelled) return;
        setState(r.count > 0 ? 'ok' : 'empty');
        setCount(r.count); setIds(r.items.map((p) => p.id));
      } catch { if (!cancelled) setState('down'); }
    };
    void tick();
    const id = setInterval(tick, 12000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const value = state === 'loading' ? '—' : state === 'down' ? '!' : count.toString();
  const title =
    state === 'ok' || state === 'empty'
      ? count > 0
        ? `Skills · ${count} on bus · 单击下钻 Bus admin →\n` + ids.map((id) => `· ${id}`).join('\n')
        : `Skills · 0 plugins · 单击进入 Bus admin`
      : state === 'down' ? 'Skills · Bus 列表暂不可读' : 'Skills · loading…';

  useStatusBarItem({
    id: 'bus.skill',
    slot: 'right',
    priority: 50,
    node: (
      <StatusChip
        tone="gold"
        state={state}
        icon={Sparkles}
        label="SKILL"
        value={value}
        title={title}
        onClick={() => { openSettings('plugins'); setPendingBusKindFilter('skill'); }}
      />
    ),
  });
  return null;
}

// ─── TOOL ─────────────────────────────────────────────────────────────────

function ToolPulseFeed() {
  const setMode = useAppStore((s) => s.setMode);
  const openSettings = useAppStore((s) => s.openSettings);
  const setPendingBusKindFilter = useAppStore((s) => s.setPendingBusKindFilter);
  const [state, setState] = useState<ChipState>('loading');
  const [count, setCount] = useState<number>(0);
  const [ids, setIds] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await listBusPlugins('tool');
        if (cancelled) return;
        setState(r.count > 0 ? 'ok' : 'empty');
        setCount(r.count); setIds(r.items.map((p) => p.id));
      } catch { if (!cancelled) setState('down'); }
    };
    void tick();
    const id = setInterval(tick, 12000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const value = state === 'loading' ? '—' : state === 'down' ? '!' : count.toString();
  const title =
    state === 'ok' || state === 'empty'
      ? count > 0
        ? `Tools · ${count} on bus · 单击下钻 Bus admin →\n` + ids.map((id) => `· ${id}`).join('\n')
        : `Tools · 0 plugins · 单击进入 Bus admin`
      : state === 'down' ? 'Tools · Bus 列表暂不可读' : 'Tools · loading…';

  useStatusBarItem({
    id: 'bus.tool',
    slot: 'right',
    priority: 45,
    node: (
      <StatusChip
        tone="orange"
        state={state}
        icon={Wrench}
        label="TOOL"
        value={value}
        title={title}
        onClick={() => { openSettings('plugins'); setPendingBusKindFilter('tool'); }}
      />
    ),
  });
  return null;
}

// ─── AGENT ────────────────────────────────────────────────────────────────

function AgentPulseFeed() {
  const setMode = useAppStore((s) => s.setMode);
  const openSettings = useAppStore((s) => s.openSettings);
  const setPendingBusKindFilter = useAppStore((s) => s.setPendingBusKindFilter);
  const [state, setState] = useState<ChipState>('loading');
  const [count, setCount] = useState<number>(0);
  const [ids, setIds] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await listBusPlugins('agent');
        if (cancelled) return;
        setState(r.count > 0 ? 'ok' : 'empty');
        setCount(r.count); setIds(r.items.map((p) => p.id));
      } catch { if (!cancelled) setState('down'); }
    };
    void tick();
    const id = setInterval(tick, 12000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const value = state === 'loading' ? '—' : state === 'down' ? '!' : count.toString();
  const title =
    state === 'ok' || state === 'empty'
      ? count > 0
        ? `Agents · ${count} on bus · 单击下钻 Bus admin →\n` + ids.map((id) => `· ${id}`).join('\n')
        : `Agents · 0 plugins · 单击进入 Bus admin`
      : state === 'down' ? 'Agents · Bus 列表暂不可读' : 'Agents · loading…';

  useStatusBarItem({
    id: 'bus.agent',
    slot: 'right',
    priority: 40,
    node: (
      <StatusChip
        tone="violet"
        state={state}
        icon={Bot}
        label="AGENT"
        value={value}
        title={title}
        onClick={() => { openSettings('plugins'); setPendingBusKindFilter('agent'); }}
      />
    ),
  });
  return null;
}
