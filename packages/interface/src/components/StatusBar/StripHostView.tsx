/**
 * StripHostView — the footer host view for `kind:'strip'` locations
 * (ADR-0030 §2.3). Renders StatusItemContributions from the SINGLE derived
 * panels snapshot (host.panels.stripItems) instead of the retired module-level
 * statusBarStore, so every footer chip flows through the one contribution
 * channel with owner-tagged, reversible lifecycle.
 *
 *   ┌────────────────────────────────────────────────────────────────────┐
 *   │ version · slug · agent            │ health      │ RES · MB · … │
 *   └────────────────────────────────────────────────────────────────────┘
 *     statusbar.left (priority desc)      statusbar.center  statusbar.right
 *
 * Each slot has a VISIBLE_PER_SLOT capacity. On overflow the trailing visible
 * position rotates through the low-priority surplus every CAROUSEL_INTERVAL_MS
 * (a deterministic rotating window — no re-mount, no state loss), preserving
 * the legacy GlobalStatusBar behavior.
 *
 * Item bodies (ADR-0030 §2.2):
 *   - text   → static label + tooltip
 *   - button → command-driven button (host.commands.execute)
 *   - custom → in-process live chip (owns its own subscriptions)
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { icons as LucideIcons } from 'lucide-react';
import { usePanelRenderers } from '../DockShell/panelRenderers';
import { useHost } from '../../core/app-shell';
import type { StatusItemContribution, StripLocationId } from '../../core/panels';
import './GlobalStatusBar.css';

type StripSlot = 'left' | 'center' | 'right';

const SLOT_OF: Record<StripLocationId, StripSlot> = {
  'statusbar.left': 'left',
  'statusbar.center': 'center',
  'statusbar.right': 'right',
};

const VISIBLE_PER_SLOT: Record<StripSlot, number> = { left: 4, center: 2, right: 6 };
const CAROUSEL_INTERVAL_MS = 4000;

export function StripHostView() {
  const renderers = usePanelRenderers();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), CAROUSEL_INTERVAL_MS);
    return () => clearInterval(t);
  }, []);

  const bySlot = useMemo(() => {
    const out: Record<StripSlot, StatusItemContribution[]> = { left: [], center: [], right: [] };
    const items = Object.values(renderers.stripItems ?? {});
    for (const it of items) {
      if (it.when && !it.when()) continue;
      out[SLOT_OF[it.location]].push(it);
    }
    for (const slot of Object.keys(out) as StripSlot[]) {
      out[slot].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    }
    return out;
  }, [renderers.stripItems]);

  return (
    <div
      className="global-status-bar"
      role="status"
      aria-live="polite"
      aria-label="forgeax status bar"
      data-fx-slot="StatusBar"
    >
      <Slot slot="left" items={bySlot.left} tick={tick} />
      <Slot slot="center" items={bySlot.center} tick={tick} />
      <Slot slot="right" items={bySlot.right} tick={tick} />
    </div>
  );
}

function Slot({ slot, items, tick }: { slot: StripSlot; items: StatusItemContribution[]; tick: number }) {
  const cap = VISIBLE_PER_SLOT[slot];
  const isOverflow = items.length > cap;
  const visible = useMemo(() => {
    if (!isOverflow) return items;
    const anchored = items.slice(0, cap - 1);
    const rotatingPool = items.slice(cap - 1);
    const rotated = rotatingPool[tick % rotatingPool.length]!;
    return [...anchored, rotated];
  }, [items, isOverflow, cap, tick]);

  const hiddenCount = isOverflow ? items.length - cap : 0;

  return (
    <div className={`sb-slot sb-slot-${slot}`} data-slot-count={items.length} data-slot-visible={visible.length}>
      {visible.map((it) => (
        <div key={it.id} className="sb-item" data-item-id={it.id}>
          <StatusItemView item={it} />
        </div>
      ))}
      {hiddenCount > 0 && (
        <span
          className="sb-overflow"
          title={`${hiddenCount} more chip(s) cycling every ${CAROUSEL_INTERVAL_MS / 1000}s · low priority items rotate through the last visible slot`}
          aria-label={`${hiddenCount} hidden status items, rotating`}
        >
          +{hiddenCount}↻
        </span>
      )}
    </div>
  );
}

function StatusItemView({ item }: { item: StatusItemContribution }): ReactNode {
  const host = useHost();
  const body = item.item;

  if (body.type === 'custom') return body.render();

  if (body.type === 'text') {
    return (
      <span className="sb-chip" title={body.tooltip}>
        {body.text}
      </span>
    );
  }

  // button
  const Icon = body.icon ? LucideIcons[body.icon as keyof typeof LucideIcons] : undefined;
  return (
    <button
      type="button"
      className="sb-chip is-button"
      title={body.tooltip}
      onClick={() => { void host.commands.execute(body.command, body.args); }}
    >
      {Icon ? <Icon size={12} className="sb-chip-icon" /> : null}
      {body.label ? <span className="sb-chip-label">{body.label}</span> : null}
    </button>
  );
}
