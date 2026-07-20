// SlotDebugOverlay — dev-time visualization of every [data-fx-slot="..."] in
// the DOM. Mounted at the interface App root when the URL has ?debug=slots
// (see isSlotDebugEnabled). Reads markers via querySelectorAll, tracks their
// position with ResizeObserver + MutationObserver + window resize/scroll, and
// paints a semi-transparent colored box + slot-name label on top of each.
// SSOT: the marker attribute is the only slot metadata; color/label/positioning
// are all derived here.
//
// pointer-events: none end-to-end — the overlay never intercepts input.
import { useEffect, useState, type ReactElement } from 'react';
import { hashHue } from './hashHue';

interface SlotBox {
  name: string;
  parentName: string | null;   // direct [data-fx-slot] ancestor's name, or null if root
  depth: number;               // count of [data-fx-slot] ancestors
  left: number;
  top: number;
  width: number;
  height: number;
}

// z-index high enough to sit above dockview + radix popovers, low enough to
// leave headroom for real modal/toast layers.
const OVERLAY_Z = 2147483000;

// Label corner rotates by depth % 4 so nested labels don't stack on top of
// each other. depth 0 → top-left, 1 → top-right, 2 → bottom-left, 3 → bottom-right.
const LABEL_CORNERS = [
  { top: 2, left: 2 },
  { top: 2, right: 2 },
  { bottom: 2, left: 2 },
  { bottom: 2, right: 2 },
] as const;

function measureAll(): SlotBox[] {
  const els = Array.from(document.querySelectorAll<Element>('[data-fx-slot]'));
  const out: SlotBox[] = [];
  for (const el of els) {
    const name = el.getAttribute('data-fx-slot') ?? '';
    if (!name) continue;
    // Use Range.getBoundingClientRect over the element's children so
    // `display: contents` wrappers (which return 0x0 from Element.getBoundingClientRect)
    // still expose the union of their children's rects. Falls back to the
    // element's own rect when it has no children (regular markers).
    let r: DOMRect;
    if (el.firstChild) {
      const range = document.createRange();
      range.selectNodeContents(el);
      r = range.getBoundingClientRect();
    } else {
      r = el.getBoundingClientRect();
    }
    if (r.width === 0 && r.height === 0) continue;
    let depth = 0;
    let parentName: string | null = null;
    let cursor: Element | null = el.parentElement;
    while (cursor) {
      if (cursor.hasAttribute('data-fx-slot')) {
        if (parentName === null) parentName = cursor.getAttribute('data-fx-slot');
        depth++;
      }
      cursor = cursor.parentElement;
    }
    out.push({ name, parentName, depth, left: r.left, top: r.top, width: r.width, height: r.height });
  }
  return out;
}

export function SlotDebugOverlay(): ReactElement {
  const [boxes, setBoxes] = useState<SlotBox[]>([]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setBoxes(measureAll()));
    };

    // Sync measure on mount so the first paint carries the correct set of
    // boxes without waiting for a frame — matters for tests and for the
    // initial visible frame after ?debug=slots is added.
    setBoxes(measureAll());

    const ro = new ResizeObserver(schedule);
    const attach = () => {
      ro.disconnect();
      document.querySelectorAll<Element>('[data-fx-slot]').forEach((el) => ro.observe(el));
    };
    attach();

    const mo = new MutationObserver((records) => {
      // Re-attaching ResizeObservers is expensive (disconnect + re-observe
      // every marker), and the game engine can mutate the DOM many times per
      // frame. Only re-attach when the set of [data-fx-slot] markers actually
      // changes; otherwise just schedule a rAF-coalesced position remeasure.
      let markerSetChanged = false;
      for (const rec of records) {
        if (rec.type === 'attributes' && rec.attributeName === 'data-fx-slot') {
          markerSetChanged = true;
          break;
        }
        if (rec.type === 'childList') {
          for (const n of rec.addedNodes) {
            if (n instanceof Element && (n.matches('[data-fx-slot]') || n.querySelector('[data-fx-slot]'))) {
              markerSetChanged = true;
              break;
            }
          }
          if (!markerSetChanged) {
            for (const n of rec.removedNodes) {
              if (n instanceof Element && (n.matches('[data-fx-slot]') || n.querySelector('[data-fx-slot]'))) {
                markerSetChanged = true;
                break;
              }
            }
          }
          if (markerSetChanged) break;
        }
      }
      if (markerSetChanged) attach();
      schedule();
    });
    mo.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-fx-slot'],
    });

    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, []);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: OVERLAY_Z,
      }}
      data-fx-slot-overlay=""
    >
      {boxes.map((b, i) => {
        const hue = hashHue(b.name);
        const fillAlpha = Math.min(0.35, 0.10 + b.depth * 0.06);
        const outlineWidth = Math.max(1, 3 - b.depth);
        const corner = LABEL_CORNERS[b.depth % 4];
        const labelText = b.parentName ? `${b.parentName} → ${b.name}` : b.name;
        return (
          <div
            key={`${b.name}:${i}`}
            style={{
              position: 'fixed',
              left: b.left,
              top: b.top,
              width: b.width,
              height: b.height,
              background: `hsla(${hue}, 65%, 55%, ${fillAlpha})`,
              outline: `${outlineWidth}px solid hsla(${hue}, 65%, 55%, 0.7)`,
              pointerEvents: 'none',
            }}
          >
            <span
              style={{
                position: 'absolute',
                ...corner,
                background: `hsla(${hue}, 65%, 25%, 0.9)`,
                color: '#fff',
                font: '10px/14px ui-monospace, monospace',
                padding: '1px 4px',
                borderRadius: 2,
                whiteSpace: 'nowrap',
              }}
            >
              {labelText}
            </span>
          </div>
        );
      })}
    </div>
  );
}
