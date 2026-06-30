/**
 * Global status bar — Blender-style bottom strip.
 *
 *   ┌────────────────────────────────────────────────────────────────────┐
 *   │ FPS 60 · slug=mario · agent=forge     │ idle      │ BUS · MB · PROV │
 *   └────────────────────────────────────────────────────────────────────┘
 *     ^                                       ^             ^
 *     left slot (sorted by priority desc)     center slot   right slot
 *
 * Each slot has a `VISIBLE_PER_SLOT` capacity.  When more items are
 * registered than that capacity, the trailing visible slots cycle through
 * the surplus items via a deterministic rotating-window strategy:
 *
 *   visible[i] = items[(tick + i) % items.length]   when overflow
 *
 * `tick` advances by 1 every `CAROUSEL_INTERVAL_MS` (4s).  All items keep
 * mounted (they live in their owner React tree); the bar simply chooses
 * which N to display via the carousel — no re-mount, no state loss.
 */

import { useEffect, useMemo, useState } from 'react';
import { useStatusBarItems, type StatusBarItem, type StatusBarSlot } from './store';
import './GlobalStatusBar.css';

const VISIBLE_PER_SLOT: Record<StatusBarSlot, number> = {
  left: 4,
  center: 2,
  right: 6,
};
const CAROUSEL_INTERVAL_MS = 4000;

export function GlobalStatusBar() {
  const items = useStatusBarItems();
  const [tick, setTick] = useState(0);

  // Single timer drives carousel rotation across every slot — all slots
  // re-pick their visible window in lockstep so the user doesn't see chips
  // changing at random offsets.
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), CAROUSEL_INTERVAL_MS);
    return () => clearInterval(t);
  }, []);

  const bySlot = useMemo(() => {
    const out: Record<StatusBarSlot, StatusBarItem[]> = { left: [], center: [], right: [] };
    for (const item of items) out[item.slot].push(item);
    for (const slot of Object.keys(out) as StatusBarSlot[]) {
      out[slot].sort((a, b) => b.priority - a.priority);
    }
    return out;
  }, [items]);

  return (
    <div className="global-status-bar" role="status" aria-live="polite" aria-label="forgeax status bar">
      <Slot slot="left"   items={bySlot.left}   tick={tick} />
      <Slot slot="center" items={bySlot.center} tick={tick} />
      <Slot slot="right"  items={bySlot.right}  tick={tick} />
    </div>
  );
}

function Slot({ slot, items, tick }: { slot: StatusBarSlot; items: StatusBarItem[]; tick: number }) {
  const cap = VISIBLE_PER_SLOT[slot];
  const isOverflow = items.length > cap;
  const visible = useMemo(() => {
    if (!isOverflow) return items;
    // Keep the top (cap - 1) chips pinned; rotate the remaining items
    // through the last visible position so the most-permanent state stays
    // anchored and only the long tail cycles.
    const anchored = items.slice(0, cap - 1);
    const rotatingPool = items.slice(cap - 1);
    const rotated = rotatingPool[tick % rotatingPool.length];
    return [...anchored, rotated];
  }, [items, isOverflow, cap, tick]);

  const hiddenCount = isOverflow ? items.length - cap : 0;

  return (
    <div className={`sb-slot sb-slot-${slot}`} data-slot-count={items.length} data-slot-visible={visible.length}>
      {visible.map((it) => (
        <div key={it.id} className="sb-item" data-item-id={it.id}>
          {it.node}
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
