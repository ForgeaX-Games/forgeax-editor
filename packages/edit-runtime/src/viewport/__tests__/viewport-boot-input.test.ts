// Regression (2026-08-07): the React chrome + global keyboard router mount
// seconds before createViewport() finishes the async engine boot. View-preset
// keys (Alt+G/H/J/K) pressed in that window hit a null handler and vanished —
// "Alt+J does nothing on a slow boot". The boot-input bridge buffers discrete
// modified-key commands and flushes them on install; plain fly keys must be
// dropped (replaying a keydown whose keyup already fired would wedge keyState
// and drift the camera).

import { describe, expect, it } from 'bun:test';
import { createViewportBootInput } from '../viewport-boot-input';

// bun's test env has no DOM KeyboardEvent — the bridge only reads
// type/key/altKey/ctrlKey/metaKey, so a structural literal is sufficient.
const key = (k: string, mods: { alt?: boolean; ctrl?: boolean } = {}): KeyboardEvent =>
  ({ type: 'keydown', key: k, altKey: mods.alt ?? false, ctrlKey: mods.ctrl ?? false, metaKey: false }) as KeyboardEvent;

describe('viewport boot-input bridge', () => {
  it('delivers immediately once installed', () => {
    const bridge = createViewportBootInput();
    const seen: string[] = [];
    bridge.install((e) => seen.push(e.key));
    bridge.route(key('j', { alt: true }));
    expect(seen).toEqual(['j']);
  });

  it('buffers modified-key commands during boot and flushes on install (in order)', () => {
    const bridge = createViewportBootInput();
    bridge.route(key('j', { alt: true }));
    bridge.route(key('1', { ctrl: true }));
    const seen: string[] = [];
    expect(bridge.isReady()).toBe(false);
    bridge.install((e) => seen.push(e.key));
    expect(bridge.isReady()).toBe(true);
    expect(seen).toEqual(['j', '1']);
  });

  it('drops plain keys pressed during boot (fly keyState safety)', () => {
    const bridge = createViewportBootInput();
    bridge.route(key('w'));
    bridge.route(key('escape'));
    const seen: string[] = [];
    bridge.install((e) => seen.push(e.key));
    expect(seen).toEqual([]);
  });

  it('drops keyup events even with modifiers held', () => {
    const bridge = createViewportBootInput();
    bridge.route({ type: 'keyup', key: 'j', altKey: true, ctrlKey: false, metaKey: false } as KeyboardEvent);
    const seen: string[] = [];
    bridge.install((e) => seen.push(e.key));
    expect(seen).toEqual([]);
  });

  it('uninstall clears pending and reports not-ready; only the owner uninstalls', () => {
    const bridge = createViewportBootInput();
    const ready: boolean[] = [];
    bridge.onReadyChange((r) => ready.push(r));
    const handler = (): void => {};
    bridge.install(handler);
    bridge.uninstall(() => {}); // not the owner — must be a no-op
    expect(bridge.isReady()).toBe(true);
    bridge.uninstall(handler);
    expect(bridge.isReady()).toBe(false);
    expect(ready).toEqual([true, false]);
    bridge.route(key('j', { alt: true }));
    const seen: string[] = [];
    bridge.install((e) => seen.push(e.key));
    expect(seen).toEqual(['j']); // queued after uninstall still flushes
  });

  it('bounds the pending queue (no unbounded growth while boot stalls)', () => {
    const bridge = createViewportBootInput();
    for (let i = 0; i < 32; i++) bridge.route(key('j', { alt: true }));
    let count = 0;
    bridge.install(() => { count++; });
    expect(count).toBe(8);
  });
});
