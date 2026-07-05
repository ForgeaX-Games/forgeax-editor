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

import { useEffect, useState } from 'react';
import { Brain, Sparkles, Wrench, Bot, Gauge } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useAppStore } from '../../../store';
import { emitDeepLink } from '../../../lib/deep-link-bus';
import { listBusPlugins } from '../../../lib/bus-api';
import { dashApi } from '../../../lib/dashboard-api';
import { useStatusBarItem } from '../store';
import { StatusChip, type ChipState } from '../StatusChip';

export function PulseFeeds() {
  return (
    <>
      <ResourcePulseFeed />
      <ModelBindingPulseFeed />
      <SkillPulseFeed />
      <ToolPulseFeed />
      <AgentPulseFeed />
    </>
  );
}

// ─── RES · server resource usage (memory · uptime · WS clients) ───────────

/** Compact uptime: "2h13m" / "13m" / "<1m". */
function fmtUptime(s: number): string {
  if (s < 60) return '<1m';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

function ResourcePulseFeed() {
  const { t } = useTranslation();
  const [state, setState] = useState<ChipState>('loading');
  const [info, setInfo] = useState<{ rssMB: number; uptime: number; ws: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const h = await dashApi.health();
        if (cancelled) return;
        const rss = typeof h.mem?.rss === 'number' ? h.mem.rss : 0;
        setInfo({ rssMB: Math.round(rss / (1024 * 1024)), uptime: h.uptime ?? 0, ws: h.wsClients ?? 0 });
        setState('ok');
      } catch { if (!cancelled) setState('down'); }
    };
    void tick();
    const timer = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const value = state === 'loading' ? '—' : state === 'down' ? '!' : `${info?.rssMB ?? 0}MB`;
  const title =
    state === 'ok' && info
      ? t('pulse.res.title.ok', { mem: String(info.rssMB), uptime: fmtUptime(info.uptime), ws: String(info.ws) })
      : state === 'down' ? t('pulse.res.title.down') : t('pulse.res.title.loading');

  useStatusBarItem({
    id: 'sys.res',
    slot: 'right',
    priority: 95,
    node: (
      <StatusChip
        tone="lime"
        state={state}
        icon={Gauge}
        label="RES"
        value={value}
        title={title}
      />
    ),
  });
  return null;
}

// ─── MB · model-binding kind count ────────────────────────────────────────

function ModelBindingPulseFeed() {
  const { t } = useTranslation();
  const setMode = useAppStore((s) => s.setMode);
  const openOverlay = useAppStore((s) => s.openOverlay);
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
        ? t('pulse.mb.title.some', { count: String(count) }) + '\n' + ids.map((id) => `· ${id}`).join('\n')
        : t('pulse.mb.title.none')
      : state === 'down' ? t('pulse.mb.title.down') : t('pulse.mb.title.loading');

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
        onClick={() => { openOverlay('settings', 'plugins'); emitDeepLink('bus:filter-kind', 'model-binding'); }}
      />
    ),
  });
  return null;
}

// ─── SKILL ────────────────────────────────────────────────────────────────

function SkillPulseFeed() {
  const { t } = useTranslation();
  const setMode = useAppStore((s) => s.setMode);
  const openOverlay = useAppStore((s) => s.openOverlay);
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
        ? t('pulse.skill.title.some', { count: String(count) }) + '\n' + ids.map((id) => `· ${id}`).join('\n')
        : t('pulse.skill.title.none')
      : state === 'down' ? t('pulse.skill.title.down') : t('pulse.skill.title.loading');

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
        onClick={() => { openOverlay('settings', 'plugins'); emitDeepLink('bus:filter-kind', 'skill'); }}
      />
    ),
  });
  return null;
}

// ─── TOOL ─────────────────────────────────────────────────────────────────

function ToolPulseFeed() {
  const { t } = useTranslation();
  const setMode = useAppStore((s) => s.setMode);
  const openOverlay = useAppStore((s) => s.openOverlay);
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
        ? t('pulse.tool.title.some', { count: String(count) }) + '\n' + ids.map((id) => `· ${id}`).join('\n')
        : t('pulse.tool.title.none')
      : state === 'down' ? t('pulse.tool.title.down') : t('pulse.tool.title.loading');

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
        onClick={() => { openOverlay('settings', 'plugins'); emitDeepLink('bus:filter-kind', 'tool'); }}
      />
    ),
  });
  return null;
}

// ─── AGENT ────────────────────────────────────────────────────────────────

function AgentPulseFeed() {
  const { t } = useTranslation();
  const setMode = useAppStore((s) => s.setMode);
  const openOverlay = useAppStore((s) => s.openOverlay);
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
        ? t('pulse.agent.title.some', { count: String(count) }) + '\n' + ids.map((id) => `· ${id}`).join('\n')
        : t('pulse.agent.title.none')
      : state === 'down' ? t('pulse.agent.title.down') : t('pulse.agent.title.loading');

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
        onClick={() => { openOverlay('settings', 'plugins'); emitDeepLink('bus:filter-kind', 'agent'); }}
      />
    ),
  });
  return null;
}
