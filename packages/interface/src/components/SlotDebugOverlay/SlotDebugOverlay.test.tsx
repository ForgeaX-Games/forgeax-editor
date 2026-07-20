import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// happy-dom lacks these — stub minimal versions so the overlay's observer
// setup + measure loop don't throw.
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
class NoopMutationObserver {
  observe(): void {}
  disconnect(): void {}
  takeRecords(): MutationRecord[] { return []; }
}

describe('SlotDebugOverlay', () => {
  let host: HTMLDivElement;
  let root: Root;
  let registeredDom = false;
  let originalGetBCR: typeof Element.prototype.getBoundingClientRect | undefined;

  beforeEach(() => {
    try { GlobalRegistrator.register(); registeredDom = true; } catch { registeredDom = false; }
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver;
    globalThis.MutationObserver = NoopMutationObserver as unknown as typeof MutationObserver;

    // happy-dom returns 0x0 for all rects. Stub getBoundingClientRect to read
    // the inline style so the overlay's zero-bbox filter doesn't skip our test
    // markers. Only affects tests; production uses the real browser rect.
    originalGetBCR = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      const s = (this as HTMLElement).style;
      const parsePx = (v: string): number => parseFloat(v) || 0;
      const width = parsePx(s.width);
      const height = parsePx(s.height);
      const left = parsePx(s.left);
      const top = parsePx(s.top);
      return {
        x: left, y: top,
        left, top,
        width, height,
        right: left + width,
        bottom: top + height,
        toJSON: () => ({}),
      } as DOMRect;
    };

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    if (originalGetBCR) {
      Element.prototype.getBoundingClientRect = originalGetBCR;
      originalGetBCR = undefined;
    }
    if (registeredDom) GlobalRegistrator.unregister();
  });

  it('renders one label per [data-fx-slot] marker with its slot name', async () => {
    // Set up two markers in the document body BEFORE mount so the initial
    // measure() picks them up (the mount-time querySelectorAll pass).
    const a = document.createElement('div');
    a.setAttribute('data-fx-slot', 'renderChat');
    a.style.cssText = 'position:fixed;left:10px;top:20px;width:100px;height:50px;';
    const b = document.createElement('div');
    b.setAttribute('data-fx-slot', 'Dashboard');
    b.style.cssText = 'position:fixed;left:200px;top:30px;width:80px;height:40px;';
    document.body.appendChild(a);
    document.body.appendChild(b);

    const { SlotDebugOverlay } = await import('./SlotDebugOverlay');
    act(() => { root.render(<SlotDebugOverlay />); });

    // Labels are the slot names, rendered as text inside the overlay.
    const overlayText = host.textContent ?? '';
    expect(overlayText).toContain('renderChat');
    expect(overlayText).toContain('Dashboard');

    a.remove();
    b.remove();
  });

  it('renders nothing when no markers exist', async () => {
    const { SlotDebugOverlay } = await import('./SlotDebugOverlay');
    act(() => { root.render(<SlotDebugOverlay />); });
    // The overlay's own container renders even with zero children — that's
    // fine (a single position:fixed root div with no per-marker boxes).
    expect(host.textContent ?? '').toBe('');
  });

  it('renders parent-breadcrumb label for a nested marker', async () => {
    const outer = document.createElement('div');
    outer.setAttribute('data-fx-slot', 'OuterSlot');
    outer.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:100px;';
    const inner = document.createElement('div');
    inner.setAttribute('data-fx-slot', 'InnerSlot');
    inner.style.cssText = 'position:absolute;left:20px;top:20px;width:80px;height:40px;';
    outer.appendChild(inner);
    document.body.appendChild(outer);

    const { SlotDebugOverlay } = await import('./SlotDebugOverlay');
    act(() => { root.render(<SlotDebugOverlay />); });

    const text = host.textContent ?? '';
    // Inner marker's label carries the breadcrumb "OuterSlot → InnerSlot".
    expect(text).toContain('OuterSlot → InnerSlot');
    // Outer marker's label is still just its own name (no ancestor).
    expect(text).toContain('OuterSlot');

    outer.remove();
  });
});
