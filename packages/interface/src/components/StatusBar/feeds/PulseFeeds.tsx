/**
 * Bus-kind pulse chips — the live MB / SKILL / TOOL / AGENT extension-registry
 * counters (originally PreviewMode's pt-right toolbar, moved to the global
 * status bar 2026-05-17). The former RES (system resource) chip was folded into
 * the diagnostics popover, since server mem/uptime/WS is environment-diagnostic
 * data, not a bus-kind count.
 *
 * Each `*Feed` polls its source, then renders a `<StatusChip>`. The visual
 * primitive is shared so the strip reads as a coherent unit; only the `tone`
 * color changes between kinds (teal/gold/orange/violet).
 */

import { useEffect, useState } from 'react';
import { Brain, Sparkles, Wrench, Bot } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useShellStore } from '../../../store';
import { emitDeepLink } from '../../../lib/deep-link-bus';
import { listExtensions } from '../../../lib/extension-api';
import type { StatusItemContribution } from '../../../core/panels';
import { StatusChip, type ChipState } from '../StatusChip';

/** ADR-0030 §2.2 — the live MB/SKILL/TOOL/AGENT pulse chips as `custom`
 *  status-item contributions. Each chip owns its own polling (the in-process
 *  escape hatch); chrome-statusbar folds these into the footer's strip channel. */
export const pulseStatusItems: readonly StatusItemContribution[] = [
  { kind: 'status-item', id: 'bus.mb',    location: 'statusbar.right', priority: 90, item: { type: 'custom', render: () => <ModelBindingPulseFeed /> } },
  { kind: 'status-item', id: 'bus.skill', location: 'statusbar.right', priority: 50, item: { type: 'custom', render: () => <SkillPulseFeed /> } },
  { kind: 'status-item', id: 'bus.tool',  location: 'statusbar.right', priority: 45, item: { type: 'custom', render: () => <ToolPulseFeed /> } },
  { kind: 'status-item', id: 'bus.agent', location: 'statusbar.right', priority: 40, item: { type: 'custom', render: () => <AgentPulseFeed /> } },
];

// ─── MB · model-binding kind count ────────────────────────────────────────

function ModelBindingPulseFeed() {
  const { t } = useTranslation();
  const openOverlay = useShellStore((s) => s.openOverlay);
  const [state, setState] = useState<ChipState>('loading');
  const [count, setCount] = useState<number>(0);
  const [ids, setIds] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await listExtensions('model-binding');
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

  return (
    <StatusChip
      tone="teal"
      state={state}
      icon={Brain}
      label="MB"
      value={value}
      title={title}
      onClick={() => { openOverlay('settings', 'plugins'); emitDeepLink('bus:filter-kind', 'model-binding'); }}
    />
  );
}

// ─── SKILL ────────────────────────────────────────────────────────────────

function SkillPulseFeed() {
  const { t } = useTranslation();
  const openOverlay = useShellStore((s) => s.openOverlay);
  const [state, setState] = useState<ChipState>('loading');
  const [count, setCount] = useState<number>(0);
  const [ids, setIds] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await listExtensions('skill');
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

  return (
    <StatusChip
      tone="gold"
      state={state}
      icon={Sparkles}
      label="SKILL"
      value={value}
      title={title}
      onClick={() => { openOverlay('settings', 'plugins'); emitDeepLink('bus:filter-kind', 'skill'); }}
    />
  );
}

// ─── TOOL ─────────────────────────────────────────────────────────────────

function ToolPulseFeed() {
  const { t } = useTranslation();
  const openOverlay = useShellStore((s) => s.openOverlay);
  const [state, setState] = useState<ChipState>('loading');
  const [count, setCount] = useState<number>(0);
  const [ids, setIds] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await listExtensions('tool');
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

  return (
    <StatusChip
      tone="orange"
      state={state}
      icon={Wrench}
      label="TOOL"
      value={value}
      title={title}
      onClick={() => { openOverlay('settings', 'plugins'); emitDeepLink('bus:filter-kind', 'tool'); }}
    />
  );
}

// ─── AGENT ────────────────────────────────────────────────────────────────

function AgentPulseFeed() {
  const { t } = useTranslation();
  const openOverlay = useShellStore((s) => s.openOverlay);
  const [state, setState] = useState<ChipState>('loading');
  const [count, setCount] = useState<number>(0);
  const [ids, setIds] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await listExtensions('agent');
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

  return (
    <StatusChip
      tone="violet"
      state={state}
      icon={Bot}
      label="AGENT"
      value={value}
      title={title}
      onClick={() => { openOverlay('settings', 'plugins'); emitDeepLink('bus:filter-kind', 'agent'); }}
    />
  );
}
